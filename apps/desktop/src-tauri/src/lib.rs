//! Tauri shell for crawlie. A thin layer over `crawlie-core`: crawl commands
//! that stream progress, plus saved-report history backed by the core
//! `ReportStore` in the app data directory.
//! Updated batch audit reporting.

use crawlie_core::{
    crawl, report_html, CancelToken, CrawlConfig, CrawlDiff, CrawlResult, ReportMeta, ReportStore,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct CrawlState {
    cancel: Mutex<Option<CancelToken>>,
    batch_cancel: Mutex<Option<CancelToken>>,
    /// The detached background PDF-rendering worker for the most recent batch
    /// run, if any is still draining. Aborted when a new batch starts or the
    /// batch is cancelled, so runs never overlap.
    pdf_worker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// User-configurable app settings, persisted to `settings.json` in the app data
/// directory. Surfaced in the in-app Settings panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// Check for a newer release when the app launches.
    check_on_launch: bool,
    /// Download and install updates automatically (no prompt).
    auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            check_on_launch: true,
            auto_update: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    std::fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

fn store(app: &AppHandle) -> ReportStore {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("reports");
    ReportStore::new(dir)
}

/// Run a crawl, emitting `crawl-event` to the webview, then auto-save it to
/// history. Returns the full result.
#[tauri::command]
async fn start_crawl(app: AppHandle, config: CrawlConfig) -> Result<CrawlResult, String> {
    let token = CancelToken::new();
    {
        let state = app.state::<CrawlState>();
        *state.cancel.lock().unwrap() = Some(token.clone());
    }

    let emitter = app.clone();
    let on_event = move |evt| {
        let _ = emitter.emit("crawl-event", evt);
    };

    let result = crawl(config, on_event, token)
        .await
        .map_err(|e| e.to_string());

    {
        let state = app.state::<CrawlState>();
        *state.cancel.lock().unwrap() = None;
    }

    if let Ok(r) = &result {
        let _ = store(&app).save(r);
    }
    result
}

#[tauri::command]
fn cancel_crawl(state: State<'_, CrawlState>) {
    if let Some(token) = state.cancel.lock().unwrap().as_ref() {
        token.cancel();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRowInput {
    pub index: usize,
    pub website: String,
    pub current_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRowOutput {
    pub index: usize,
    pub website: String,
    pub updated_email: String,
    pub website_audit: String,
    pub emails_found: Vec<String>,
    pub status: String,
    /// Absolute path to this row's PDF audit report, filled in later via a
    /// `batch-pdf-ready` event — always `None` at the moment the row itself
    /// completes, since PDF rendering runs on a decoupled background worker
    /// that never blocks the audit (see `audit_batch`).
    pub pdf_path: Option<String>,
}

/// One site queued for the background PDF worker: the rendered client-summary
/// HTML plus every row index that shares this site (rows are deduped by
/// normalized URL — a site listed more than once in the spreadsheet is
/// crawled and PDF'd once, not once per duplicate row).
struct PdfJob {
    indices: Vec<usize>,
    url: String,
    html: String,
}

/// Emitted once a queued row's PDF finishes (or definitively fails) — arrives
/// independently of, and generally after, that row's `batch-row-completed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfReady {
    index: usize,
    pdf_path: Option<String>,
}

/// Hard cap on concurrent tabs across the *entire* batch's shared browser —
/// both JS-rendered crawl pages and PDF prints draw from this one budget.
/// Each tab is its own OS process under Chrome's architecture, so this is a
/// real memory cap: without it, `row_concurrency` sites running in parallel,
/// each opening up to `config.concurrency` tabs for its own pages, multiply
/// unchecked (e.g. 25 rows × 16 = 400+ tabs, several GB of RAM). Deliberately
/// independent of, and much smaller than, either concurrency slider.
const MAX_SHARED_RENDERER_TABS: usize = 3;
/// Conservative per-PDF size estimate for the disk-space preflight check.
/// Recalibrate from real batches once there's field data.
const ESTIMATED_PDF_BYTES: u64 = 1_500_000;
/// Always leave at least this much free on the destination drive.
const MIN_HEADROOM_BYTES: u64 = 1_000_000_000;
/// How often (in PDFs written) to re-check free space mid-run.
const DISK_RECHECK_INTERVAL: usize = 250;
/// How often the RAM guard re-measures usage.
const MEM_POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// Once paused, don't resume until usage drops back under this fraction of
/// the configured limit — avoids rapidly flapping pause/resume right at the edge.
const MEM_RESUME_FRACTION: u64 = 85;

/// Total resident memory (MB) of `root` plus every descendant process (any
/// process anywhere in its child tree) — i.e. this app plus every Chrome/Edge
/// helper process it spawned. Chrome's multi-process architecture means each
/// tab is its own OS process, so summing just the top-level process would
/// badly undercount actual usage.
fn process_tree_memory_mb(sys: &sysinfo::System, root: sysinfo::Pid) -> u64 {
    use std::collections::HashSet;
    let mut total_bytes: u64 = 0;
    let mut stack = vec![root];
    let mut seen: HashSet<sysinfo::Pid> = HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(p) = sys.process(pid) {
            total_bytes += p.memory();
        }
        for (candidate_pid, candidate) in sys.processes() {
            if candidate.parent() == Some(pid) && !seen.contains(candidate_pid) {
                stack.push(*candidate_pid);
            }
        }
    }
    total_bytes / 1_000_000
}

/// Render one site's report HTML to a PDF via the shared headless browser,
/// writing it into `dir` as `<host>.pdf` — one flat folder, one file per site;
/// a rerun of the same site overwrites its previous PDF with the fresh one.
/// Mirrors crawlie-cli's `export_pdf`. Any failure at any step (temp write,
/// navigation, print, final write) just yields `None` — a single site's PDF
/// never aborts anything else. `temp_tag` only keeps concurrent temp HTML
/// files from colliding; it isn't part of the final filename.
async fn render_pdf_for_site(
    renderer: &crawlie_core::render::Renderer,
    html: &str,
    dir: &PathBuf,
    url_str: &str,
    temp_tag: usize,
) -> Option<String> {
    let tmp = std::env::temp_dir().join(format!("crawlie-batch-{}-{}.html", std::process::id(), temp_tag));
    std::fs::write(&tmp, html).ok()?;
    let file_url = url::Url::from_file_path(&tmp).ok();
    let bytes = match &file_url {
        Some(u) => renderer.pdf(u).await.ok(),
        None => None,
    };
    let _ = std::fs::remove_file(&tmp);
    let bytes = bytes?;

    let host = url::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.replace('.', "-")))
        .unwrap_or_else(|| "site".into());
    let path = dir.join(format!("{host}.pdf"));
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn audit_batch(
    app: AppHandle,
    rows: Vec<BatchRowInput>,
    mut config: CrawlConfig,
    row_concurrency: usize,
    // User-chosen PDF output folder (via a native picker). `None` falls back
    // to Downloads, matching `save_html_report`'s convention.
    pdf_dir_override: Option<String>,
    // User-configurable RAM ceiling (MB) for this app's whole process tree
    // (itself + every Chrome/Edge helper it spawns). Not a hard OS-enforced
    // limit — a cooperative guard: once usage reaches this, no *new* site
    // audits start (in-flight ones are left to finish) until usage drops
    // back down. `0` disables the guard entirely.
    max_ram_mb: u64,
) -> Result<Vec<BatchRowOutput>, String> {
    let token = CancelToken::new();
    {
        let state = app.state::<CrawlState>();
        *state.batch_cancel.lock().unwrap() = Some(token.clone());
        // A previous run's PDF worker (if still draining) must not keep
        // writing into this run's directory or racing its events.
        if let Some(h) = state.pdf_worker.lock().unwrap().take() {
            h.abort();
        };
    }

    // `config` is a per-run template — every row clones it and re-targets
    // `url` (see `config_for_row`). `row_concurrency` is a separate axis from
    // `config.concurrency`: how many *sites* run in parallel, vs. how many
    // requests each site's own crawl makes at once.
    let want_render_js = config.render;

    // --- Shared headless browser: launched at most once per batch (never
    // once per row), reused by every JS-rendered row's crawl AND by the PDF
    // pipeline below. Neither ever blocks or slows the audit itself — each
    // is either fully ready before any row starts, or skipped entirely (with
    // one warning) and rows proceed as if it didn't exist. ---
    // One flat, stable folder — never a new subfolder per run. A user-chosen
    // folder (via the picker) is used exactly as given; the default lives
    // under Downloads. Re-running the same site overwrites its previous PDF.
    let pdf_dir = match pdf_dir_override {
        Some(dir) => PathBuf::from(dir),
        None => app
            .path()
            .download_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| e.to_string())?
            .join("crawlie-pdf-reports"),
    };

    // Rows sharing a normalized URL (a site listed more than once in the
    // spreadsheet) are crawled and PDF'd once — see the grouping below. The
    // disk-space estimate should reflect that real count, not the raw row count.
    let unique_site_count = {
        let mut seen = std::collections::HashSet::new();
        for row in &rows {
            let trimmed = row.website.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(norm) = crawlie_core::normalize_target_url(trimmed) {
                seen.insert(norm);
            }
        }
        seen.len()
    };

    let pdf_storage_ok = if std::fs::create_dir_all(&pdf_dir).is_err() {
        false
    } else {
        let required = ESTIMATED_PDF_BYTES
            .saturating_mul(unique_site_count as u64)
            .saturating_mul(13)
            / 10
            + MIN_HEADROOM_BYTES;
        let free = fs4::available_space(&pdf_dir).unwrap_or(u64::MAX);
        if free < required {
            let _ = app.emit(
                "batch-pdf-warning",
                format!(
                    "Not enough free disk space for PDF reports (need ~{:.1} GB, only ~{:.1} GB free) — \
                     PDF generation is disabled for this run, but audits will continue.",
                    required as f64 / 1e9,
                    free as f64 / 1e9,
                ),
            );
            false
        } else {
            true
        }
    };

    let mut shared_renderer: Option<Arc<crawlie_core::render::Renderer>> = None;
    let mut pdf_tx: Option<tokio::sync::mpsc::UnboundedSender<PdfJob>> = None;

    if pdf_storage_ok || want_render_js {
        match crawlie_core::render::Renderer::launch_shared(None, 45, MAX_SHARED_RENDERER_TABS).await {
            Err(e) => {
                let mut disabled = Vec::new();
                if pdf_storage_ok {
                    disabled.push("PDF report generation");
                }
                if want_render_js {
                    disabled.push("JavaScript rendering");
                }
                let _ = app.emit(
                    "batch-pdf-warning",
                    format!(
                        "Chrome/Edge not found — {} disabled for this run, but audits will continue. ({e})",
                        disabled.join(" and "),
                    ),
                );
                // Never fall back to a per-row browser launch — force it off
                // so `crawl_with_renderer` doesn't try (and fail) per row.
                config.render = false;
            }
            Ok(renderer) => {
                let renderer = Arc::new(renderer);
                shared_renderer = Some(renderer.clone());

                if pdf_storage_ok {
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PdfJob>();
                    pdf_tx = Some(tx);

                    let app_for_worker = app.clone();
                    let dir = pdf_dir.clone();
                    let handle = tauri::async_runtime::spawn(async move {
                        let written = Arc::new(AtomicUsize::new(0));
                        let low_disk = Arc::new(AtomicBool::new(false));

                        // No local semaphore here: `renderer.pdf()` already
                        // queues behind the browser's own shared tab budget
                        // (`MAX_SHARED_RENDERER_TABS`), the same one JS-rendered
                        // crawl pages draw from — one real ceiling on concurrent
                        // tabs, not two independent ones that could add up.
                        while let Some(job) = rx.recv().await {
                            if low_disk.load(Ordering::Relaxed) {
                                for idx in &job.indices {
                                    let _ = app_for_worker.emit(
                                        "batch-pdf-ready",
                                        PdfReady { index: *idx, pdf_path: None },
                                    );
                                }
                                continue;
                            }
                            let renderer = renderer.clone();
                            let dir = dir.clone();
                            let app_for_job = app_for_worker.clone();
                            let written = written.clone();
                            let low_disk = low_disk.clone();
                            tauri::async_runtime::spawn(async move {
                                let temp_tag = job.indices.first().copied().unwrap_or(0);
                                let pdf_path =
                                    render_pdf_for_site(&renderer, &job.html, &dir, &job.url, temp_tag).await;
                                for idx in &job.indices {
                                    let _ = app_for_job.emit(
                                        "batch-pdf-ready",
                                        PdfReady { index: *idx, pdf_path: pdf_path.clone() },
                                    );
                                }

                                let n = written.fetch_add(1, Ordering::Relaxed) + 1;
                                if n % DISK_RECHECK_INTERVAL == 0
                                    && fs4::available_space(&dir).unwrap_or(u64::MAX) < MIN_HEADROOM_BYTES
                                    && !low_disk.swap(true, Ordering::Relaxed)
                                {
                                    let _ = app_for_job.emit(
                                        "batch-pdf-warning",
                                        "Disk space is running low — PDF generation has been disabled for the remaining rows in this batch.".to_string(),
                                    );
                                }
                            });
                        }
                    });

                    let state = app.state::<CrawlState>();
                    *state.pdf_worker.lock().unwrap() = Some(handle);
                }
            }
        }
    }
    let want_pdf = pdf_tx.is_some();
    let config = config;

    // --- RAM guard: cooperative, not a hard OS-enforced limit. Polls this
    // app's whole process tree (itself + every Chrome/Edge helper it
    // spawned — Chrome's multi-process model means tab count already caps
    // this, but this is a second, independent backstop) and flips a flag new
    // row tasks check before starting. In-flight audits are never
    // interrupted — only *new* ones wait, and only until usage drops back
    // under a lower threshold, so a big batch slows near the ceiling instead
    // of failing outright. ---
    let over_ram_limit = Arc::new(AtomicBool::new(false));
    let mem_monitor = if max_ram_mb > 0 {
        let over_ram_limit = over_ram_limit.clone();
        let app_for_mem = app.clone();
        let my_pid = sysinfo::Pid::from_u32(std::process::id());
        Some(tauri::async_runtime::spawn(async move {
            let mut sys = sysinfo::System::new_all();
            let mut paused = false;
            loop {
                tokio::time::sleep(MEM_POLL_INTERVAL).await;
                sys.refresh_all();
                let used_mb = process_tree_memory_mb(&sys, my_pid);
                if used_mb >= max_ram_mb {
                    if !paused {
                        paused = true;
                        over_ram_limit.store(true, Ordering::Relaxed);
                        let _ = app_for_mem.emit(
                            "batch-pdf-warning",
                            format!(
                                "Memory usage hit {used_mb} MB (your {max_ram_mb} MB limit) — pausing new site audits \
                                 until in-progress ones finish and usage drops. Nothing already running is interrupted.",
                            ),
                        );
                    }
                } else if paused && used_mb < max_ram_mb * MEM_RESUME_FRACTION / 100 {
                    paused = false;
                    over_ram_limit.store(false, Ordering::Relaxed);
                    let _ = app_for_mem.emit(
                        "batch-pdf-warning",
                        format!("Memory usage back down to {used_mb} MB — resuming new site audits."),
                    );
                }
            }
        }))
    } else {
        None
    };

    // Group rows by normalized target URL — a site listed more than once in
    // the spreadsheet (common in scraped lead lists) is crawled and PDF'd
    // once, not once per duplicate row. Empty/invalid rows need no crawl and
    // are resolved immediately, outside the grouped work below.
    let mut groups: HashMap<String, Vec<BatchRowInput>> = HashMap::new();
    let mut results: Vec<BatchRowOutput> = Vec::new();
    for row in rows {
        let website_trimmed = row.website.trim().to_string();
        if website_trimmed.is_empty() {
            let out = BatchRowOutput {
                index: row.index,
                website: row.website,
                updated_email: row.current_email.unwrap_or_default(),
                website_audit: "no website".to_string(),
                emails_found: Vec::new(),
                status: "skipped".to_string(),
                pdf_path: None,
            };
            let _ = app.emit("batch-row-completed", &out);
            results.push(out);
            continue;
        }
        match crawlie_core::normalize_target_url(&website_trimmed) {
            Some(norm) => groups.entry(norm).or_default().push(row),
            None => {
                let out = BatchRowOutput {
                    index: row.index,
                    website: row.website,
                    updated_email: row.current_email.unwrap_or_default(),
                    website_audit: "Error: Invalid website URL".to_string(),
                    emails_found: Vec::new(),
                    status: "error".to_string(),
                    pdf_path: None,
                };
                let _ = app.emit("batch-row-completed", &out);
                results.push(out);
            }
        }
    }

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(row_concurrency.clamp(1, 30)));
    let mut tasks = futures::stream::FuturesUnordered::new();

    for (norm_url, group_rows) in groups {
        let app_handle = app.clone();
        let token_clone = token.clone();
        let sem_clone = sem.clone();
        let pdf_tx_clone = pdf_tx.clone();
        let config_template = config.clone();
        let renderer_clone = shared_renderer.clone();
        let over_ram_limit = over_ram_limit.clone();

        tasks.push(async move {
            // If cancelled before starting
            if token_clone.is_cancelled() {
                let mut outs = Vec::with_capacity(group_rows.len());
                for row in group_rows {
                    let out = BatchRowOutput {
                        index: row.index,
                        website: row.website,
                        updated_email: row.current_email.unwrap_or_default(),
                        website_audit: "Error: Cancelled".to_string(),
                        emails_found: Vec::new(),
                        status: "error".to_string(),
                        pdf_path: None,
                    };
                    let _ = app_handle.emit("batch-row-completed", &out);
                    outs.push(out);
                }
                return outs;
            }

            // Acquire concurrency permit (one permit per unique site, not per row)
            let _permit = sem_clone.acquire().await.ok();

            if token_clone.is_cancelled() {
                let mut outs = Vec::with_capacity(group_rows.len());
                for row in group_rows {
                    let out = BatchRowOutput {
                        index: row.index,
                        website: row.website,
                        updated_email: row.current_email.unwrap_or_default(),
                        website_audit: "Error: Cancelled".to_string(),
                        emails_found: Vec::new(),
                        status: "error".to_string(),
                        pdf_path: None,
                    };
                    let _ = app_handle.emit("batch-row-completed", &out);
                    outs.push(out);
                }
                return outs;
            }

            // RAM guard: hold here (this site hasn't started crawling yet, so
            // nothing in-flight is affected) until usage drops back down.
            while over_ram_limit.load(Ordering::Relaxed) {
                if token_clone.is_cancelled() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if token_clone.is_cancelled() {
                let mut outs = Vec::with_capacity(group_rows.len());
                for row in group_rows {
                    let out = BatchRowOutput {
                        index: row.index,
                        website: row.website,
                        updated_email: row.current_email.unwrap_or_default(),
                        website_audit: "Error: Cancelled".to_string(),
                        emails_found: Vec::new(),
                        status: "error".to_string(),
                        pdf_path: None,
                    };
                    let _ = app_handle.emit("batch-row-completed", &out);
                    outs.push(out);
                }
                return outs;
            }

            // Run the audit once for this site, regardless of how many rows share it
            let row_config = crawlie_core::config_for_row(&config_template, &norm_url);
            let outcome = crawlie_core::audit_website_for_batch(
                row_config,
                token_clone.clone(),
                want_pdf,
                renderer_clone,
            )
            .await;

            let status = if outcome.success {
                "success".to_string()
            } else {
                "error".to_string()
            };

            // Hand the rendered HTML off to the background PDF worker —
            // non-blocking, so this site's rows complete at exactly the same
            // speed whether or not PDF generation is active. One PDF covers
            // every row sharing this site.
            if let (Some(tx), Some(html)) = (&pdf_tx_clone, &outcome.report_html) {
                let _ = tx.send(PdfJob {
                    indices: group_rows.iter().map(|r| r.index).collect(),
                    url: norm_url.clone(),
                    html: html.clone(),
                });
            }

            let mut outs = Vec::with_capacity(group_rows.len());
            for row in group_rows {
                let updated_email = if outcome.success && !outcome.emails.is_empty() {
                    crawlie_core::merge_emails(row.current_email.as_deref(), &outcome.emails)
                } else {
                    row.current_email.unwrap_or_default()
                };
                let out = BatchRowOutput {
                    index: row.index,
                    website: row.website,
                    updated_email,
                    website_audit: outcome.report.clone(),
                    emails_found: outcome.emails.clone(),
                    status: status.clone(),
                    pdf_path: None,
                };
                let _ = app_handle.emit("batch-row-completed", &out);
                outs.push(out);
            }
            outs
        });
    }

    use futures::StreamExt;
    while let Some(outs) = tasks.next().await {
        results.extend(outs);
    }

    results.sort_by_key(|r| r.index);

    // The RAM guard only needs to run while rows are still starting — every
    // row is accounted for by now, so stop polling.
    if let Some(h) = mem_monitor {
        h.abort();
    }

    {
        let state = app.state::<CrawlState>();
        *state.batch_cancel.lock().unwrap() = None;
    }

    // `pdf_tx` (and every row task's clone) is dropped here as the function
    // returns. Once the last sender drops, the background worker drains
    // whatever's left in the channel and exits on its own — it keeps running
    // (and keeps emitting `batch-pdf-ready`) after this command has already
    // resolved, which is the point: PDFs trail behind, they never gate it.
    Ok(results)
}

#[tauri::command]
fn cancel_batch(state: State<'_, CrawlState>) {
    if let Some(token) = state.batch_cancel.lock().unwrap().as_ref() {
        token.cancel();
    }
    if let Some(h) = state.pdf_worker.lock().unwrap().take() {
        h.abort();
    }
}

#[tauri::command]
fn list_reports(app: AppHandle) -> Vec<ReportMeta> {
    store(&app).list()
}

#[tauri::command]
fn load_report(app: AppHandle, id: String) -> Option<CrawlResult> {
    store(&app).load(&id)
}

#[tauri::command]
fn delete_report(app: AppHandle, id: String) -> Result<(), String> {
    store(&app).delete(&id).map_err(|e| e.to_string())
}

/// Compare two saved crawls (crawl-over-crawl trend). Returns `None` if either
/// id is unknown.
#[tauri::command]
fn diff_reports(
    app: AppHandle,
    old_id: String,
    new_id: String,
) -> Result<Option<CrawlDiff>, String> {
    store(&app)
        .diff(&old_id, &new_id)
        .map_err(|e| e.to_string())
}

/// Render a shareable, self-contained HTML report and save it (to Downloads if
/// possible). Returns the absolute path written.
// --- Crawlie Cloud session ---
//
// The desktop app shares one token file with the CLI and MCP server
// (`~/.crawlie/auth.json`), so signing in anywhere signs in everywhere. The
// device flow runs in the webview (fetch + open browser); these commands just
// read/write the shared file.

fn auth_file() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".crawlie").join("auth.json")
}

#[tauri::command]
fn auth_load() -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(auth_file()).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn auth_save(
    token: String,
    endpoint: String,
    email: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "access_token": token,
        "token_type": "Bearer",
        "endpoint": endpoint,
        "user": { "email": email, "name": name },
    });
    let path = auth_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn auth_clear() -> Result<(), String> {
    match std::fs::remove_file(auth_file()) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Render a shareable, self-contained HTML report and save it (to Downloads if
/// possible). Returns the absolute path written.
#[tauri::command]
fn save_html_report(app: AppHandle, result: CrawlResult) -> Result<String, String> {
    let html = report_html::render(&result);
    let host = url::Url::parse(&result.config.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.replace('.', "-")))
        .unwrap_or_else(|| "site".into());
    let name = format!("crawlie-{host}-{}.html", result.started_at);

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(name);
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Write arbitrary binary or text bytes to an absolute path chosen by the user
/// via the native Save dialog. Creates parent directories if needed.
#[tauri::command]
fn save_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(p, data).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(CrawlState::default())
        .invoke_handler(tauri::generate_handler![
            start_crawl,
            cancel_crawl,
            audit_batch,
            cancel_batch,
            list_reports,
            load_report,
            delete_report,
            diff_reports,
            save_html_report,
            save_file_bytes,
            get_settings,
            set_settings,
            auth_load,
            auth_save,
            auth_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running crawlie");
}

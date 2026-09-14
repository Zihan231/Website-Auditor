//! Render a crawl result as a polished, professionally structured audit
//! report suitable for handing to a client — plain-English guidance, but
//! *complete*: every issue found, with a table of every affected page, not
//! just a top-5 summary. Distinct from `report_html::render` (the
//! collapsible, developer-facing report used by the "Share" export and CLI
//! `--format html`), this one renders everything fully expanded and static
//! so nothing is hidden once printed to PDF.

use crate::knowledge::rule_info;
use crate::types::{BrokenLink, Category, CrawlResult, Severity};
use std::collections::BTreeMap;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Client-friendly label for a severity — "Error"/"Warning"/"Notice" read as
/// developer jargon; a business owner understands "Critical"/"Important" faster.
fn plain_severity(s: Severity) -> &'static str {
    match s {
        Severity::Error => "Critical",
        Severity::Warning => "Important",
        Severity::Notice => "Minor",
        Severity::Good => "Good",
    }
}

fn severity_class(s: Severity) -> &'static str {
    match s {
        Severity::Error => "crit",
        Severity::Warning => "imp",
        Severity::Notice => "min",
        Severity::Good => "good",
    }
}

fn sev_rank(s: Severity) -> u8 {
    match s {
        Severity::Error => 3,
        Severity::Warning => 2,
        Severity::Notice => 1,
        Severity::Good => 0,
    }
}

fn verdict_class(avg: u32) -> &'static str {
    match avg {
        85..=100 => "great",
        70..=84 => "good",
        50..=69 => "fair",
        _ => "poor",
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| url.to_string())
}

fn score_class(v: u8) -> &'static str {
    match v {
        85..=100 => "s-great",
        70..=84 => "s-good",
        50..=69 => "s-fair",
        _ => "s-poor",
    }
}

/// Every affected URL is capped per finding so one runaway rule can't blow
/// the report up to thousands of pages; the remainder is summarized instead.
const MAX_ROWS_PER_FINDING: usize = 50;
const MAX_BROKEN_LINK_ROWS: usize = 75;

struct Finding<'a> {
    title: String,
    category: Category,
    severity: Severity,
    rows: Vec<(&'a str, &'a Option<String>)>,
    total: usize,
}

/// Render a complete, client-ready HTML audit report: scores and a
/// plain-English verdict up front, then every finding from the audit with a
/// table of every affected page (capped per finding), a dedicated broken-
/// links table, and a status-code breakdown. Renders fully expanded — no
/// collapsible elements — so nothing is missing once printed to PDF.
pub fn render(r: &CrawlResult) -> String {
    let s = &r.summary;
    let host = host_of(&r.config.url);
    let date = crate::timefmt::format_utc(r.started_at);

    let avg = (s.health_score as u32 + s.geo_score as u32 + s.a11y_score as u32) / 3;
    let verdict_class = verdict_class(avg);
    let verdict_headline = match verdict_class {
        "great" => "Excellent shape",
        "good" => "Good shape",
        "fair" => "Needs some work",
        _ => "Needs attention",
    };

    let total_issues = s.errors + s.warnings + s.notices;
    let issues_sentence = if total_issues == 0 {
        "We didn't find anything wrong during this audit — nice work.".to_string()
    } else {
        let urgency_clause = if s.errors == 0 {
            "None of these are urgent, but they're still worth fixing.".to_string()
        } else if s.errors == 1 {
            "1 of these is urgent and worth fixing first; the rest are lower priority.".to_string()
        } else {
            format!(
                "{} of these are urgent and worth fixing first; the rest are lower priority.",
                s.errors
            )
        };
        format!(
            "We checked {} page{} on this website and found {} issue{} that could be affecting how easily \
             customers and search engines find it. {}",
            s.total_pages,
            if s.total_pages == 1 { "" } else { "s" },
            total_issues,
            if total_issues == 1 { "" } else { "s" },
            urgency_clause,
        )
    };

    let good_note = if s.good > 0 {
        format!(
            "<p>On the plus side, this audit also confirmed {} thing{} the site is already doing right.</p>",
            s.good,
            if s.good == 1 { "" } else { "s" }
        )
    } else {
        String::new()
    };

    // A few plain, scannable numbers for a reader who just wants the gist —
    // the detailed breakdown (with every affected page) is one page turn away.
    let stat_chips = format!(
        r#"<div class="stat-chips">
  <div class="chip"><div class="chip-v">{pages}</div><div class="chip-k">Pages Checked</div></div>
  <div class="chip"><div class="chip-v">{total}</div><div class="chip-k">Issues Found</div></div>
  <div class="chip chip-urgent"><div class="chip-v">{errors}</div><div class="chip-k">Urgent</div></div>
  <div class="chip"><div class="chip-v">{good}</div><div class="chip-k">Working Well</div></div>
</div>"#,
        pages = s.total_pages,
        total = total_issues,
        errors = s.errors,
        good = s.good,
    );

    // Group every non-"good" issue by rule, in document order per group,
    // capped for the table but with the *true* total preserved for the
    // "N pages affected" line.
    let mut groups: BTreeMap<String, Finding> = BTreeMap::new();
    for i in r.issues.iter().filter(|i| i.severity != Severity::Good) {
        let f = groups.entry(i.rule.clone()).or_insert_with(|| Finding {
            title: i.title.clone(),
            category: i.category,
            severity: i.severity,
            rows: Vec::new(),
            total: 0,
        });
        f.total += 1;
        if f.rows.len() < MAX_ROWS_PER_FINDING {
            f.rows.push((i.url.as_str(), &i.detail));
        }
    }
    let mut ordered: Vec<(String, Finding)> = groups.into_iter().collect();
    ordered.sort_by(|a, b| {
        sev_rank(b.1.severity)
            .cmp(&sev_rank(a.1.severity))
            .then(b.1.total.cmp(&a.1.total))
    });

    let findings_html = if ordered.is_empty() {
        "<p class=\"muted\">No issues to report — the site is in solid shape.</p>".to_string()
    } else {
        let mut out = String::new();
        for (rule, f) in &ordered {
            let info = rule_info(rule);
            let why = info.as_ref().map(|i| esc(&i.why)).unwrap_or_default();
            let how = info.as_ref().map(|i| esc(&i.how_to_fix)).unwrap_or_default();
            let impact = info.as_ref().map(|i| esc(&i.impact)).unwrap_or_default();
            let impact_html = if impact.is_empty() {
                String::new()
            } else {
                format!("<p class=\"impact\">If left as-is: {impact}</p>")
            };

            let mut rows_html = String::new();
            for (url, detail) in &f.rows {
                let detail_html = detail
                    .as_ref()
                    .map(|d| esc(d))
                    .unwrap_or_default();
                rows_html.push_str(&format!(
                    "<tr><td class=\"url\">{}</td><td class=\"detail\">{}</td></tr>",
                    esc(url),
                    detail_html
                ));
            }
            if f.total > f.rows.len() {
                rows_html.push_str(&format!(
                    "<tr class=\"more\"><td colspan=\"2\">+ {} more page{}</td></tr>",
                    f.total - f.rows.len(),
                    if f.total - f.rows.len() == 1 { "" } else { "s" }
                ));
            }

            out.push_str(&format!(
                r#"<div class="finding {cls}"><div class="finding-head"><span class="pill {cls}">{sev}</span><span class="ft">{title}</span><span class="cat">{cat}</span><span class="fc">{count} page{plural}</span></div>{why_html}{how_html}{impact}<table class="urls"><thead><tr><th>Affected page</th><th>Detail</th></tr></thead><tbody>{rows}</tbody></table></div>"#,
                cls = severity_class(f.severity),
                sev = plain_severity(f.severity),
                title = esc(&f.title),
                cat = esc(f.category.label()),
                count = f.total,
                plural = if f.total == 1 { "" } else { "s" },
                why_html = if why.is_empty() { String::new() } else { format!("<p class=\"why\">{why}</p>") },
                how_html = if how.is_empty() { String::new() } else { format!("<p class=\"how\"><b>What to do:</b> {how}</p>") },
                impact = impact_html,
                rows = rows_html,
            ));
        }
        out
    };

    // Broken links get their own target-centric table (one row per dead
    // URL, not per occurrence) — the same data the in-app Issues tab shows.
    let broken_html = if r.broken_links.is_empty() {
        String::new()
    } else {
        let mut sorted = r.broken_links.clone();
        sorted.sort_by(|a: &BrokenLink, b: &BrokenLink| b.count.cmp(&a.count));
        let mut rows = String::new();
        for bl in sorted.iter().take(MAX_BROKEN_LINK_ROWS) {
            rows.push_str(&format!(
                "<tr><td class=\"mono\">{}</td><td class=\"url\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                bl.status,
                esc(&bl.url),
                bl.count,
                bl.sources.len(),
            ));
        }
        if sorted.len() > MAX_BROKEN_LINK_ROWS {
            rows.push_str(&format!(
                "<tr class=\"more\"><td colspan=\"4\">+ {} more broken links</td></tr>",
                sorted.len() - MAX_BROKEN_LINK_ROWS
            ));
        }
        format!(
            r#"<div class="sect-head sect-broken"><h2>Broken Links</h2></div><p class="muted">Every dead link found, with how many pages link to it.</p><table class="urls"><thead><tr><th>Status</th><th>Broken URL</th><th class="num">Times linked</th><th class="num">Pages linking to it</th></tr></thead><tbody>{rows}</tbody></table>"#
        )
    };

    // Status-code breakdown — short, useful context for a technical reader
    // without requiring one.
    let status_html = {
        let mut rows: Vec<(String, usize)> = s.by_status.iter().map(|(k, v)| (k.clone(), *v)).collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let body: String = rows
            .iter()
            .map(|(code, n)| {
                let label = if code == "0" { "Connection error".to_string() } else { code.clone() };
                format!("<tr><td class=\"mono\">{}</td><td class=\"num\">{}</td></tr>", esc(&label), n)
            })
            .collect();
        format!(
            r#"<div class="sect-head sect-status"><h2>Pages Checked</h2></div><table class="status"><thead><tr><th>Status</th><th class="num">Count</th></tr></thead><tbody>{body}</tbody></table>"#
        )
    };

    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website audit — {host}</title>
<style>{css}</style></head>
<body>

<header class="topband">
  <div class="topband-inner">
    <div class="brandmark">◆</div>
    <div class="grow">
      <div class="eyebrow">Website Audit Report</div>
      <h1>{host}</h1>
      <div class="url mono">{url}</div>
    </div>
    <div class="meta">Audited {date}<br>{pages} page{pages_plural} checked</div>
  </div>
</header>

<div class="wrap">

<section class="scores">
  <div class="score-card {hclass}">
    <div class="ring" style="--pct:{health}"><div class="ring-inner"><span class="ring-val">{health}</span><small>/100</small></div></div>
    <div class="score-k">Technical Health</div>
  </div>
  <div class="score-card {gclass}">
    <div class="ring" style="--pct:{geo}"><div class="ring-inner"><span class="ring-val">{geo}</span><small>/100</small></div></div>
    <div class="score-k">AI Search Readiness</div>
  </div>
  <div class="score-card {aclass}">
    <div class="ring" style="--pct:{a11y}"><div class="ring-inner"><span class="ring-val">{a11y}</span><small>/100</small></div></div>
    <div class="score-k">Accessibility</div>
  </div>
</section>

<section class="summary {vclass}">
  <div class="verdict-line">
    <span class="verdict-dot"></span>
    <span class="verdict-headline">{verdict_headline}</span>
  </div>
  <p>{issues_sentence}</p>
  {good_note}
  {stat_chips}
</section>

<p class="turn-note">A complete, page-by-page breakdown of every issue — including exactly which pages are affected — starts on the next page.</p>

<div class="page-break"></div>

<div class="sect-head sect-findings"><h2>Detailed Findings</h2></div>
<p class="muted">Every issue found, ranked by priority, with every affected page listed.</p>
<div class="findings">{findings}</div>

{broken}
{status}

<footer class="botband">Website audit report · generated {date} · crawlie</footer>
</div></body></html>"#,
        host = esc(&host),
        url = esc(&r.config.url),
        css = CSS,
        date = esc(&date),
        pages = s.total_pages,
        pages_plural = if s.total_pages == 1 { "" } else { "s" },
        health = s.health_score,
        geo = s.geo_score,
        a11y = s.a11y_score,
        hclass = score_class(s.health_score),
        gclass = score_class(s.geo_score),
        aclass = score_class(s.a11y_score),
        verdict_headline = verdict_headline,
        vclass = format!("v-{verdict_class}"),
        issues_sentence = issues_sentence,
        good_note = good_note,
        stat_chips = stat_chips,
        findings = findings_html,
        broken = broken_html,
        status = status_html,
    )
}

const CSS: &str = r#"
:root{
  --bg:#fff;--fg:#171717;--mut:#64748b;--bd:#e2e8f0;--card:#f8fafc;
  --ink:#0f172a;--indigo:#4f46e5;--indigo-tint:#eef2ff;
  --crit:#dc2626;--crit-tint:#fef2f2;--crit-bd:#fecaca;
  --imp:#b45309;--imp-tint:#fffbeb;--imp-bd:#fde68a;
  --min:#475569;--min-tint:#f8fafc;--min-bd:#e2e8f0;
  --good:#15803d;--good-tint:#f0fdf4;--good-bd:#bbf7d0;
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:var(--fg);background:#fff}

/* --- Header band: full-bleed, dark, brand accent underline --- */
.topband{background:linear-gradient(135deg,var(--ink),#1e1b4b);color:#fff;border-bottom:4px solid var(--indigo)}
.topband-inner{max-width:860px;margin:0 auto;padding:34px 28px;display:flex;align-items:center;gap:18px}
.brandmark{width:44px;height:44px;flex-shrink:0;border-radius:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--indigo);background:#fff}
.grow{flex:1;min-width:0}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#a5b4fc;font-weight:700}
h1{font-size:27px;margin:4px 0 6px;letter-spacing:-.02em;color:#fff}
.topband .url{font-size:13px;color:#cbd5e1}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.muted{color:var(--mut)}
.meta{font-size:13px;text-align:right;white-space:nowrap;line-height:1.6;color:#cbd5e1;flex-shrink:0}

.wrap{max-width:860px;margin:0 auto;padding:32px 28px 50px}

/* --- Score rings --- */
.scores{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:26px}
.score-card{border-radius:14px;padding:20px 16px;text-align:center;border:1px solid var(--bd)}
.score-card.s-great,.score-card.s-good{background:var(--good-tint);border-color:var(--good-bd)}
.score-card.s-fair{background:var(--imp-tint);border-color:var(--imp-bd)}
.score-card.s-poor{background:var(--crit-tint);border-color:var(--crit-bd)}
.ring{
  --ring-color:var(--good);
  width:100px;height:100px;border-radius:50%;margin:0 auto 12px;
  background:conic-gradient(var(--ring-color) calc(var(--pct)*1%), rgba(0,0,0,.08) 0);
  display:flex;align-items:center;justify-content:center;
}
.score-card.s-fair .ring{--ring-color:var(--imp)}
.score-card.s-poor .ring{--ring-color:var(--crit)}
.ring-inner{width:78px;height:78px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;gap:2px;line-height:1}
.ring-val{font-size:26px;font-weight:800;letter-spacing:-.02em;color:var(--ink);line-height:1}
.ring-inner small{font-size:12px;color:var(--mut);line-height:1;position:relative;top:1px}
.score-k{font-size:13px;font-weight:600;color:var(--ink)}

/* --- Summary callout: the whole non-technical "page one" story --- */
.summary{background:var(--card);border:1px solid var(--bd);border-left:5px solid var(--bd);border-radius:12px;padding:22px 24px;margin-bottom:10px}
.summary.v-great,.summary.v-good{border-left-color:var(--good);background:var(--good-tint)}
.summary.v-fair{border-left-color:var(--imp);background:var(--imp-tint)}
.summary.v-poor{border-left-color:var(--crit);background:var(--crit-tint)}
.summary p{margin:0 0 10px;font-size:15px;line-height:1.6}
.summary p:last-of-type{margin-bottom:0}
.verdict-line{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.verdict-dot{width:14px;height:14px;border-radius:50%;background:var(--mut);flex-shrink:0}
.v-great .verdict-dot,.v-good .verdict-dot{background:var(--good)}
.v-fair .verdict-dot{background:var(--imp)}
.v-poor .verdict-dot{background:var(--crit)}
.verdict-headline{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.stat-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
.chip{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:12px 8px;text-align:center}
.chip-v{font-size:22px;font-weight:800;color:var(--ink);letter-spacing:-.02em}
.chip-k{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.03em;font-weight:600;margin-top:2px}
.chip-urgent .chip-v{color:var(--crit)}
.turn-note{text-align:center;color:var(--mut);font-size:13px;font-style:italic;margin:16px 0 0}
.page-break{page-break-after:always;break-after:page;height:0}

/* --- Section headers: colored chip + accent bar, distinct per section --- */
.sect-head{display:flex;align-items:center;padding:9px 16px;border-radius:9px;margin:32px 0 4px}
.sect-head h2{margin:0;font-size:18px;letter-spacing:-.01em;font-weight:700}
.sect-findings{background:var(--indigo-tint);border-left:5px solid var(--indigo)}
.sect-findings h2{color:#3730a3}
.sect-broken{background:var(--crit-tint);border-left:5px solid var(--crit)}
.sect-broken h2{color:#991b1b}
.sect-status{background:var(--min-tint);border-left:5px solid #64748b}
.sect-status h2{color:var(--ink)}

/* --- Findings --- */
.findings{margin-top:14px;display:grid;gap:14px}
.finding{border:1px solid var(--bd);border-radius:12px;padding:16px 18px;break-inside:avoid;page-break-inside:avoid;background:#fff;border-left-width:5px}
.finding.crit{background:var(--crit-tint);border-color:var(--crit-bd);border-left-color:var(--crit)}
.finding.imp{background:var(--imp-tint);border-color:var(--imp-bd);border-left-color:var(--imp)}
.finding.min{background:var(--min-tint);border-color:var(--min-bd);border-left-color:#94a3b8}
.finding-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.ft{font-weight:700;color:var(--ink)}
.cat{font-size:12px;color:var(--mut);background:#fff;border:1px solid var(--bd);border-radius:999px;padding:2px 9px}
.fc{font-size:12px;color:var(--mut);margin-left:auto;font-weight:600}
.pill{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:3px 10px;border-radius:999px;border:1px solid;flex-shrink:0}
.pill.crit{color:#fff;background:var(--crit);border-color:var(--crit)}
.pill.imp{color:#fff;background:var(--imp);border-color:var(--imp)}
.pill.min{color:#fff;background:var(--min);border-color:var(--min)}
.finding p{margin:6px 0 0;font-size:13.5px}
.finding .impact{color:var(--mut);font-size:12.5px;font-style:italic}

/* --- Tables: dark header row, zebra striping --- */
table.urls{width:100%;border-collapse:collapse;margin-top:12px;font-size:12.5px;background:#fff;border-radius:8px;overflow:hidden}
table.urls thead tr{background:var(--ink)}
table.urls th{text-align:left;font-weight:600;color:#e2e8f0;font-size:11px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px}
table.urls td{padding:7px 10px;border-bottom:1px solid var(--bd);vertical-align:top;word-break:break-all}
table.urls tbody tr:nth-child(even){background:#f8fafc}
table.urls td.url{font-family:ui-monospace,Menlo,monospace;font-size:12px}
table.urls td.detail{color:var(--mut)}
table.urls tr.more td{color:#aaa;font-style:italic;text-align:center;border-bottom:none;background:#fff}
table.status{border-collapse:collapse;width:320px;margin-top:12px;font-size:13px;border-radius:8px;overflow:hidden}
table.status thead tr{background:var(--ink)}
table.status th{color:#e2e8f0;padding:8px 12px;text-align:left}
table.status td{border-bottom:1px solid var(--bd);padding:7px 12px;text-align:left}
table.status tbody tr:nth-child(even){background:#f8fafc}
.num{text-align:right}

footer.botband{margin-top:44px;padding:18px 0;border-top:3px solid var(--ink);color:var(--mut);font-size:12px;text-align:center}
"#;

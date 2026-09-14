import { useState, useRef, useMemo, useEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  UploadCloud,
  FileSpreadsheet,
  Play,
  Square,
  Download,
  CheckCircle2,
  AlertCircle,
  Mail,
  Globe,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  FileText,
  Folder,
  X,
} from "lucide-react";
import {
  auditBatch,
  cancelBatch,
  isTauri,
  listenForPdfEvents,
  openExternal,
  pickFolder,
  pickSavePath,
  revealFileInFolder,
  saveFileBytes,
  type BatchRowInput,
  type BatchRowOutput,
} from "../lib/api";
import type { CrawlConfig, UrlFilter } from "../lib/types";
import { DEFAULT_CONFIG } from "../lib/types";
import { getCrawlDefaults } from "../lib/crawl-defaults";
import { IconChevron, Toggle } from "../components/ui";

type AuditStatus = "idle" | "running" | "done" | "cancelled";

/** Split a textarea into one trimmed entry per line, as exclusion rules
 *  (same convention as StartView's single-site crawl config). */
const toFilters = (text: string, regex: boolean): UrlFilter[] =>
  text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => ({ value, regex }));

const EXCEL_MAX_CELL_CHARS = 32000;

function truncateCellForSpreadsheet(val: unknown): unknown {
  if (typeof val === "string" && val.length > EXCEL_MAX_CELL_CHARS) {
    return (
      val.slice(0, EXCEL_MAX_CELL_CHARS - 120) +
      "\n\n[... Truncated: Exceeded Excel 32,767 character-per-cell limit. See full audit in the generated PDF report.]"
    );
  }
  return val;
}

export function BulkAuditView({ onBack }: { onBack?: () => void }) {
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);

  const [websiteCol, setWebsiteCol] = useState<string>("");
  const [emailCol, setEmailCol] = useState<string>("");

  // Full crawl config, shared by every row (each row just re-targets `url`)
  // — same defaults and shape as the single-site audit's StartView.
  const [cfg, setCfg] = useState<CrawlConfig>(() => ({ ...DEFAULT_CONFIG, ...getCrawlDefaults(), maxPages: 200 }));
  const [rowConcurrency, setRowConcurrency] = useState<number>(10);
  const [pdfDir, setPdfDir] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [hostsText, setHostsText] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [hostsRegex, setHostsRegex] = useState(false);
  const [pathsRegex, setPathsRegex] = useState(false);

  const set = <K extends keyof CrawlConfig>(key: K, v: CrawlConfig[K]) => setCfg({ ...cfg, [key]: v });
  const numField = (label: string, key: keyof CrawlConfig, min = 1) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input input-sm mono"
        type="number"
        min={min}
        disabled={status === "running"}
        value={cfg[key] as number}
        onChange={(e) => set(key, Math.max(min, Number(e.target.value) || min) as CrawlConfig[typeof key])}
      />
    </div>
  );

  const [status, setStatus] = useState<AuditStatus>("idle");
  const [results, setResults] = useState<Map<number, BatchRowOutput>>(new Map());
  const [currentProgress, setCurrentProgress] = useState<string>("");
  const [pdfWarning, setPdfWarning] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<"csv" | "xlsx" | null>(null);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<{ path: string; format: string } | null>(null);
  const [exportErrorMsg, setExportErrorMsg] = useState<string | null>(null);

  // PDF reports render on a background worker decoupled from the audit
  // itself, so they keep arriving after a run finishes (or even after a new
  // one starts) — listen for the whole lifetime of this view, not per-run.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenForPdfEvents(
      (update) => {
        setResults((prev) => {
          const existing = prev.get(update.index);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(update.index, { ...existing, pdfPath: update.pdfPath });
          return next;
        });
      },
      (message) => setPdfWarning(message)
    ).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "skipped" | "error">("all");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-detect website and email columns from headers
  const autoDetectColumns = (cols: string[]) => {
    const webRegex = /^(website|site|url|web|domain|homepage|website\s*url|link)$/i;
    const emailRegex = /^(email|e-mail|mail|emails|contact\s*email)$/i;

    let detectedWeb = cols.find((c) => webRegex.test(c.trim())) || "";
    if (!detectedWeb) {
      detectedWeb = cols.find((c) => c.toLowerCase().includes("web") || c.toLowerCase().includes("site") || c.toLowerCase().includes("url")) || "";
    }

    let detectedEmail = cols.find((c) => emailRegex.test(c.trim())) || "";
    if (!detectedEmail) {
      detectedEmail = cols.find((c) => c.toLowerCase().includes("mail")) || "";
    }

    setWebsiteCol(detectedWeb || cols[0] || "");
    setEmailCol(detectedEmail || "");
  };

  // Parse dropped or selected file
  const handleFile = (file: File) => {
    setFileName(file.name);
    setResults(new Map());
    setStatus("idle");

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          if (res.meta.fields && res.meta.fields.length > 0) {
            setHeaders(res.meta.fields);
            setRows(res.data as Record<string, any>[]);
            autoDetectColumns(res.meta.fields);
          }
        },
        error: (err) => {
          alert(`Error reading CSV: ${err.message}`);
        },
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: "" });

          if (json.length > 0) {
            const detectedHeaders = Object.keys(json[0]);
            setHeaders(detectedHeaders);
            setRows(json);
            autoDetectColumns(detectedHeaders);
          }
        } catch (err) {
          alert(`Error reading Excel file: ${String(err)}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      alert("Please upload a .csv or .xlsx file.");
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  // Start Batch Audit
  const handleStart = async () => {
    if (!websiteCol) {
      alert("Please select the column that contains the website URLs.");
      return;
    }

    setStatus("running");
    setResults(new Map());
    setCurrentProgress("Initializing batch...");

    const batchInputs: BatchRowInput[] = rows.map((row, idx) => ({
      index: idx,
      website: String(row[websiteCol] || ""),
      currentEmail: emailCol ? String(row[emailCol] || "") : undefined,
    }));

    const finalConfig: CrawlConfig = {
      ...cfg,
      excludeHosts: toFilters(hostsText, hostsRegex),
      excludePaths: toFilters(pathsText, pathsRegex),
    };

    try {
      await auditBatch(
        batchInputs,
        finalConfig,
        rowConcurrency,
        pdfDir,
        (completedRow) => {
          setResults((prev) => {
            const next = new Map(prev);
            next.set(completedRow.index, completedRow);
            return next;
          });
          setCurrentProgress(`Processed row ${completedRow.index + 1} of ${batchInputs.length} (${completedRow.website || "no website"})`);
        }
      );
      setStatus("done");
      setCurrentProgress("Audit complete!");
    } catch (err) {
      setStatus("done");
      setCurrentProgress(`Batch ended: ${String(err)}`);
    }
  };

  const handleCancel = async () => {
    await cancelBatch();
    setStatus("cancelled");
    setCurrentProgress("Audit cancelled by user.");
  };

  // Export Enriched File
  const handleExport = async (format: "csv" | "xlsx") => {
    if (rows.length === 0 || exportingFormat !== null) return;

    setExportErrorMsg(null);
    setExportSuccessMsg(null);

    const baseName = fileName.replace(/\.[^/.]+$/, "") || "audit-leads";
    const defaultExportName = `${baseName}-enriched.${format}`;

    // 1. If running inside Tauri desktop app, prompt the user with native Save-As dialog
    let savePath: string | null = null;
    if (isTauri()) {
      try {
        savePath = await pickSavePath({
          defaultPath: defaultExportName,
          filters:
            format === "csv"
              ? [{ name: "CSV (Comma delimited)", extensions: ["csv"] }]
              : [{ name: "Excel Spreadsheet", extensions: ["xlsx"] }],
        });
      } catch (err) {
        setExportErrorMsg(`Could not open save dialog: ${String(err)}`);
        return;
      }

      // User cancelled the file picker dialog
      if (!savePath) {
        return;
      }
    }

    setExportingFormat(format);

    try {
      const enrichedRows = rows.map((row, idx) => {
        const res = results.get(idx);
        const out = { ...row };

        // Update email column
        if (emailCol) {
          out[emailCol] = res ? res.updatedEmail : (row[emailCol] || "");
        }

        // Add "website audit" column (safely truncated to fit spreadsheet cell limits)
        const auditText = res ? res.websiteAudit : (row[websiteCol]?.trim() ? "Pending" : "no website");
        out["website audit"] = truncateCellForSpreadsheet(auditText);

        // PDF report path — blank if still generating or unavailable for this row.
        out["pdf report"] = res?.pdfPath || "";

        return out;
      });

      if (format === "csv") {
        // Include UTF-8 BOM so Excel opens special characters correctly
        const csvStr = "\uFEFF" + Papa.unparse(enrichedRows);

        if (isTauri() && savePath) {
          const bytes = new TextEncoder().encode(csvStr);
          await saveFileBytes(savePath, bytes);
          setExportSuccessMsg({ path: savePath, format: "CSV" });
        } else {
          const blob = new Blob([csvStr], { type: "text/csv;charset=utf-8;" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = defaultExportName;
          a.click();
          URL.revokeObjectURL(url);
          setExportSuccessMsg({ path: defaultExportName, format: "CSV" });
        }
      } else {
        // Double-check all columns so SheetJS never encounters any cell string > 32,767 characters
        const sanitizedRows = enrichedRows.map((row) => {
          const clean: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            clean[key] = truncateCellForSpreadsheet(value);
          }
          return clean;
        });

        const ws = XLSX.utils.json_to_sheet(sanitizedRows);

        // Make the "pdf report" cells clickable links to the local PDF file.
        const cols = Object.keys(enrichedRows[0] ?? {});
        const pdfColIdx = cols.indexOf("pdf report");
        if (pdfColIdx >= 0) {
          enrichedRows.forEach((r, i) => {
            const p = r["pdf report"];
            if (!p) return;
            const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: pdfColIdx }); // +1: row 0 is the header
            const fileUrl = "file:///" + encodeURI(String(p).replace(/\\/g, "/"));
            if (ws[cellRef]) ws[cellRef].l = { Target: fileUrl, Tooltip: "Open PDF audit report" };
          });
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Enriched Data");

        if (isTauri() && savePath) {
          const buffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
          await saveFileBytes(savePath, new Uint8Array(buffer));
          setExportSuccessMsg({ path: savePath, format: "Excel" });
        } else {
          XLSX.writeFile(wb, defaultExportName);
          setExportSuccessMsg({ path: defaultExportName, format: "Excel" });
        }
      }
    } catch (err) {
      setExportErrorMsg(`Export failed: ${String(err)}`);
    } finally {
      setExportingFormat(null);
    }
  };

  // Summary Metrics
  const totalRows = rows.length;
  const processedCount = results.size;
  const percentComplete = totalRows > 0 ? Math.round((processedCount / totalRows) * 100) : 0;

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let newEmailsCount = 0;
  let pdfReadyCount = 0;

  results.forEach((r) => {
    if (r.status === "success") successCount++;
    else if (r.status === "skipped") skippedCount++;
    else if (r.status === "error") errorCount++;
    if (r.emailsFound && r.emailsFound.length > 0) {
      newEmailsCount += r.emailsFound.length;
    }
    if (r.pdfPath) pdfReadyCount++;
  });

  // Filtered rows for preview table
  const previewRows = useMemo(() => {
    return rows
      .map((row, idx) => ({ row, idx, result: results.get(idx) }))
      .filter(({ row, result }) => {
        if (statusFilter !== "all") {
          if (!result || result.status !== statusFilter) return false;
        }
        if (searchFilter) {
          const q = searchFilter.toLowerCase();
          const web = String(row[websiteCol] || "").toLowerCase();
          const em = String(row[emailCol] || "").toLowerCase();
          const aud = result?.websiteAudit.toLowerCase() || "";
          return web.includes(q) || em.includes(q) || aud.includes(q);
        }
        return true;
      });
  }, [rows, results, websiteCol, emailCol, statusFilter, searchFilter]);

  return (
    <div style={{ padding: "32px 40px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
            Bulk CSV / Excel Audit & Email Enrichment
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 14 }}>
            Crawl thousands of websites in parallel, discover hidden emails, and generate comprehensive audit reports into a single file.
          </p>
        </div>
        {onBack && (
          <button className="btn btn-secondary" onClick={onBack}>
            Back
          </button>
        )}
      </div>

      {/* File Upload Dropzone (if no rows loaded or in idle) */}
      {rows.length === 0 ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: "2px dashed var(--border)",
            borderRadius: 12,
            padding: "60px 20px",
            textAlign: "center",
            cursor: "pointer",
            background: "var(--surface)",
            transition: "all 0.2s ease",
          }}
        >
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            accept=".csv, .xlsx, .xls"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <UploadCloud size={48} style={{ color: "var(--accent)", marginBottom: 16 }} />
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            Drop your CSV or Excel file here
          </h2>
          <p style={{ color: "var(--muted)", margin: "0 0 16px", fontSize: 14 }}>
            Supports 1 to 10,000+ rows (.csv, .xlsx) with website links and email columns.
          </p>
          <button className="btn btn-primary" type="button">
            Browse Files
          </button>
        </div>
      ) : (
        /* Configuration & Progress Section */
        <div>
          {/* File & Column Configuration Bar */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "20px 24px",
              marginBottom: 24,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <FileSpreadsheet size={24} style={{ color: "var(--accent)" }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{fileName}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>
                    {totalRows.toLocaleString()} rows loaded · {headers.length} columns
                  </div>
                </div>
              </div>
              {status !== "running" && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setRows([]);
                    setHeaders([]);
                    setFileName("");
                    setResults(new Map());
                    setStatus("idle");
                  }}
                >
                  <RefreshCw size={13} style={{ marginRight: 6 }} />
                  Change File
                </button>
              )}
            </div>

            {/* Column Mapping Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 20 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                  WEBSITE COLUMN <span style={{ color: "var(--red-text)" }}>*</span>
                </label>
                <select
                  className="input"
                  value={websiteCol}
                  disabled={status === "running"}
                  onChange={(e) => setWebsiteCol(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="">-- Select Column --</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                  EMAIL COLUMN (TO ENRICH)
                </label>
                <select
                  className="input"
                  value={emailCol}
                  disabled={status === "running"}
                  onChange={(e) => setEmailCol(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="">-- None (Only add Audit Report) --</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                  WEBSITES IN PARALLEL
                </label>
                <select
                  className="input"
                  value={rowConcurrency}
                  disabled={status === "running"}
                  onChange={(e) => setRowConcurrency(Number(e.target.value))}
                  style={{ width: "100%" }}
                >
                  <option value={5}>5 websites at once</option>
                  <option value={10}>10 websites at once (Balanced)</option>
                  <option value={15}>15 websites at once (High Speed)</option>
                  <option value={25}>25 websites at once (Turbo)</option>
                </select>
              </div>
            </div>

            {/* Per-site crawl settings — same fields/defaults as the single-site audit */}
            <div className="config-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16, marginBottom: 16 }}>
              {numField("Max pages", "maxPages")}
              {numField("Max depth", "maxDepth", 0)}
              {numField("Concurrency (per site)", "concurrency")}
              {numField("Timeout (s)", "timeoutSecs")}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                PDF REPORT FOLDER
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={status === "running"}
                  onClick={async () => {
                    const dir = await pickFolder();
                    if (dir) setPdfDir(dir);
                  }}
                >
                  <Folder size={13} style={{ marginRight: 6 }} />
                  Choose folder…
                </button>
                <span style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
                  {pdfDir ?? "Downloads (default)"}
                </span>
                {pdfDir && (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={status === "running"}
                    title="Reset to default (Downloads)"
                    onClick={() => setPdfDir(null)}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                All PDFs save directly here, one per site (named after its domain). Re-running a site overwrites its previous PDF with the latest report. Sites listed more than once in your spreadsheet are audited and PDF'd only once.
              </span>
            </div>

            <div className="audit-toggles" style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
              <Toggle
                on={cfg.checkExternal}
                onChange={(v) => set("checkExternal", v)}
                label="Verify external links"
                hint="HEAD-check links that point off-site."
              />
              <Toggle on={cfg.respectRobots} onChange={(v) => set("respectRobots", v)} label="Respect robots.txt" />
              <Toggle on={cfg.useSitemap} onChange={(v) => set("useSitemap", v)} label="Seed from sitemap" />
              <Toggle
                on={cfg.render}
                onChange={(v) => set("render", v)}
                label="Render JavaScript"
                hint="Audit each page after headless Chrome runs its JS — for React, Vue & Next sites. Slower; needs Chrome / Chromium / Edge installed. One shared browser is used for the whole batch, not one per site."
              />
            </div>

            <div className="audit-advanced" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className="disclosure"
                onClick={() => setAdvanced(!advanced)}
                style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--muted)", fontSize: 13 }}
              >
                <span style={{ display: "inline-flex", transform: advanced ? "rotate(90deg)" : "none", transition: "transform 150ms" }}>
                  <IconChevron size={14} />
                </span>
                Advanced — user agent & exclusions
              </button>

              {advanced && (
                <div className="advanced-panel" style={{ marginTop: 12, display: "grid", gap: 16 }}>
                  <div className="field">
                    <label>User agent</label>
                    <input
                      className="input input-sm mono"
                      style={{ width: "100%" }}
                      disabled={status === "running"}
                      value={cfg.userAgent}
                      onChange={(e) => set("userAgent", e.target.value)}
                      placeholder="crawlie/…"
                    />
                  </div>

                  <div className="exclude-group">
                    <div className="exclude-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label>Excluded hosts</label>
                      <label className="regex-inline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                        Regex
                        <button
                          type="button"
                          role="switch"
                          aria-checked={hostsRegex}
                          aria-label="Match hosts as regex"
                          className={`switch sm${hostsRegex ? " on" : ""}`}
                          disabled={status === "running"}
                          onClick={() => setHostsRegex(!hostsRegex)}
                        >
                          <span className="knob" />
                        </button>
                      </label>
                    </div>
                    <textarea
                      className="input mono"
                      style={{ height: 70, padding: 10, resize: "vertical", width: "100%" }}
                      disabled={status === "running"}
                      placeholder={hostsRegex ? "^ads\\.\nfacebook\\.com$" : "twitter.com\nfacebook"}
                      value={hostsText}
                      onChange={(e) => setHostsText(e.target.value)}
                    />
                    <span className="tertiary exclude-hint" style={{ fontSize: 12, color: "var(--muted)" }}>
                      One per line.{" "}
                      {hostsRegex
                        ? "Each line is a regular expression matched against the host."
                        : "Substring match — “twitter” matches twitter.com and twitter.net."}
                    </span>
                  </div>

                  <div className="exclude-group">
                    <div className="exclude-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label>Excluded paths</label>
                      <label className="regex-inline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                        Regex
                        <button
                          type="button"
                          role="switch"
                          aria-checked={pathsRegex}
                          aria-label="Match paths as regex"
                          className={`switch sm${pathsRegex ? " on" : ""}`}
                          disabled={status === "running"}
                          onClick={() => setPathsRegex(!pathsRegex)}
                        >
                          <span className="knob" />
                        </button>
                      </label>
                    </div>
                    <textarea
                      className="input mono"
                      style={{ height: 70, padding: 10, resize: "vertical", width: "100%" }}
                      disabled={status === "running"}
                      placeholder={pathsRegex ? "\\.php$\n^/cart" : "/share\n/cart"}
                      value={pathsText}
                      onChange={(e) => setPathsText(e.target.value)}
                    />
                    <span className="tertiary exclude-hint" style={{ fontSize: 12, color: "var(--muted)" }}>
                      One per line.{" "}
                      {pathsRegex
                        ? "Each line is a regular expression matched against the URL path."
                        : "Substring match — “/share” matches any path containing it."}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Actions Bar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: 12 }}>
                {status !== "running" ? (
                  <button className="btn btn-primary" onClick={handleStart}>
                    <Play size={15} style={{ marginRight: 6 }} />
                    {status === "done" ? "Re-Run Audit" : "Start Bulk Audit"}
                  </button>
                ) : (
                  <button className="btn btn-danger" onClick={handleCancel}>
                    <Square size={14} style={{ marginRight: 6 }} />
                    Stop / Cancel
                  </button>
                )}
              </div>

              {/* Download Buttons */}
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn btn-secondary"
                  disabled={processedCount === 0 || exportingFormat !== null}
                  onClick={() => handleExport("csv")}
                  title="Choose path and save enriched CSV"
                >
                  {exportingFormat === "csv" ? (
                    <>
                      <RefreshCw size={14} style={{ animation: "spin 1s linear infinite", marginRight: 6 }} />
                      Saving CSV…
                    </>
                  ) : (
                    <>
                      <Download size={14} style={{ marginRight: 6 }} />
                      Download CSV
                    </>
                  )}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={processedCount === 0 || exportingFormat !== null}
                  onClick={() => handleExport("xlsx")}
                  title="Choose path and save enriched Excel (.xlsx) file"
                >
                  {exportingFormat === "xlsx" ? (
                    <>
                      <RefreshCw size={14} style={{ animation: "spin 1s linear infinite", marginRight: 6 }} />
                      Saving Excel…
                    </>
                  ) : (
                    <>
                      <Download size={14} style={{ marginRight: 6 }} />
                      Download Excel (.xlsx)
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Export Feedback Banners */}
            {exportSuccessMsg && (
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "rgba(34, 197, 94, 0.12)",
                  border: "1px solid rgba(34, 197, 94, 0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                  <CheckCircle2 size={16} style={{ color: "var(--good, #22c55e)", flexShrink: 0 }} />
                  <span style={{ color: "var(--foreground)", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                    <strong>{exportSuccessMsg.format} file saved:</strong> {exportSuccessMsg.path}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {isTauri() && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 12, padding: "4px 10px" }}
                      onClick={() => revealFileInFolder(exportSuccessMsg.path)}
                    >
                      Show in Folder
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ padding: 4, background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)" }}
                    onClick={() => setExportSuccessMsg(null)}
                    title="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            {exportErrorMsg && (
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "rgba(239, 68, 68, 0.12)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle size={16} style={{ color: "var(--error, #ef4444)", flexShrink: 0 }} />
                  <span style={{ color: "var(--foreground)" }}>{exportErrorMsg}</span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ padding: 4, background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)" }}
                  onClick={() => setExportErrorMsg(null)}
                  title="Dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Progress & Metrics Dashboard */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 16, marginBottom: 24 }}>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>TOTAL ROWS</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{totalRows.toLocaleString()}</div>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>PROCESSED</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "var(--accent)" }}>
                {processedCount.toLocaleString()} <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>({percentComplete}%)</span>
              </div>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>AUDITED (SUCCESS)</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "var(--green-text, #10b981)" }}>
                {successCount.toLocaleString()}
              </div>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>NO WEBSITE</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "var(--muted)" }}>
                {skippedCount.toLocaleString()}
              </div>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>EMAILS DISCOVERED</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "#3b82f6" }}>
                {newEmailsCount.toLocaleString()}
              </div>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>PDFs READY</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "var(--accent)" }}>
                {pdfReadyCount.toLocaleString()} <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>/ {successCount.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* PDF pipeline warning (missing browser, low disk space, ...) — one-time, dismissible */}
          {pdfWarning && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                background: "var(--amber-bg, #fef3c7)",
                border: "1px solid var(--amber, #f59e0b)",
                borderRadius: 10,
                padding: "12px 16px",
                marginBottom: 24,
                fontSize: 13,
                color: "var(--amber-text, #92400e)",
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1 }}>{pdfWarning}</span>
              <button
                className="icon-btn"
                onClick={() => setPdfWarning(null)}
                title="Dismiss"
                style={{ color: "inherit" }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Progress Bar */}
          {status === "running" && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, color: "var(--muted)" }}>
                <span>{currentProgress}</span>
                <span>{percentComplete}%</span>
              </div>
              <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${percentComplete}%`,
                    background: "var(--accent)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}

          {/* Results Table Section */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            {/* Table Filter / Search Bar */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Real-Time Audit Records</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  Showing {previewRows.length} of {totalRows}
                </span>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ position: "relative" }}>
                  <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: "var(--muted)" }} />
                  <input
                    type="text"
                    placeholder="Search records..."
                    className="input"
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    style={{ paddingLeft: 30, width: 180, height: 32, fontSize: 13 }}
                  />
                </div>
                <select
                  className="input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  style={{ height: 32, fontSize: 13 }}
                >
                  <option value="all">All Statuses</option>
                  <option value="success">Audited (Success)</option>
                  <option value="skipped">No Website</option>
                  <option value="error">Error / Unreachable</option>
                </select>
              </div>
            </div>

            {/* Table Content */}
            <div style={{ maxHeight: 520, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
                <thead>
                  <tr style={{ background: "var(--background)", borderBottom: "1px solid var(--border)", color: "var(--muted)" }}>
                    <th style={{ padding: "10px 16px", width: 60 }}>#</th>
                    <th style={{ padding: "10px 16px", width: 220 }}>Website</th>
                    <th style={{ padding: "10px 16px", width: 220 }}>Email (Enriched)</th>
                    <th style={{ padding: "10px 16px" }}>Website Audit Preview</th>
                    <th style={{ padding: "10px 16px", width: 110 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 100).map(({ row, idx, result }) => {
                    const isExpanded = expandedIndex === idx;
                    const websiteVal = row[websiteCol] || "";
                    const emailVal = result ? result.updatedEmail : (row[emailCol] || "—");

                    return (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          background: isExpanded ? "var(--background)" : "transparent",
                        }}
                      >
                        <td style={{ padding: "12px 16px", color: "var(--muted)" }}>{idx + 1}</td>
                        <td style={{ padding: "12px 16px", fontWeight: 500, wordBreak: "break-all" }}>
                          {websiteVal ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Globe size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                              {websiteVal}
                            </span>
                          ) : (
                            <span style={{ color: "var(--muted)", fontStyle: "italic" }}>no website</span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px", wordBreak: "break-all" }}>
                          {result?.emailsFound && result.emailsFound.length > 0 ? (
                            <span style={{ color: "#3b82f6", fontWeight: 600 }}>
                              <Mail size={13} style={{ display: "inline", marginRight: 4 }} />
                              {emailVal}
                            </span>
                          ) : (
                            <span>{emailVal}</span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {result ? (
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div
                                  onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                                  style={{
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    color: "var(--accent)",
                                    fontWeight: 500,
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  {result.status === "skipped"
                                    ? "no website"
                                    : result.status === "error"
                                    ? result.websiteAudit
                                    : "View Audit Summary"}
                                </div>
                                {result.status === "success" && (
                                  result.pdfPath ? (
                                    <button
                                      className="btn btn-secondary btn-sm"
                                      onClick={(e) => { e.stopPropagation(); void openExternal(result.pdfPath!); }}
                                      title="Open PDF audit report"
                                      style={{ padding: "2px 8px", fontSize: 12 }}
                                    >
                                      <FileText size={12} style={{ marginRight: 4 }} />
                                      PDF
                                    </button>
                                  ) : (
                                    <span style={{ color: "var(--muted)", fontSize: 12, fontStyle: "italic" }}>
                                      Generating PDF…
                                    </span>
                                  )
                                )}
                              </div>
                              {isExpanded && (
                                <pre
                                  style={{
                                    marginTop: 10,
                                    padding: 14,
                                    background: "var(--background)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 8,
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    whiteSpace: "pre-wrap",
                                    maxHeight: 280,
                                    overflowY: "auto",
                                    fontFamily: "var(--font-mono, monospace)",
                                  }}
                                >
                                  {result.websiteAudit}
                                </pre>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: "var(--muted)", fontStyle: "italic" }}>
                              {status === "running" ? "Queued..." : "Ready"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {!result ? (
                            <span style={{ color: "var(--muted)", fontSize: 12 }}>Pending</span>
                          ) : result.status === "success" ? (
                            <span className="badge badge-good" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <CheckCircle2 size={12} /> Audited
                            </span>
                          ) : result.status === "skipped" ? (
                            <span className="badge badge-notice" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              Skipped
                            </span>
                          ) : (
                            <span className="badge badge-error" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <AlertCircle size={12} /> Error
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

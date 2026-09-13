import { useState, useRef, useMemo } from "react";
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
} from "lucide-react";
import {
  auditBatch,
  cancelBatch,
  type BatchRowInput,
  type BatchRowOutput,
} from "../lib/api";

type AuditStatus = "idle" | "running" | "done" | "cancelled";

export function BulkAuditView({ onBack }: { onBack?: () => void }) {
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);

  const [websiteCol, setWebsiteCol] = useState<string>("");
  const [emailCol, setEmailCol] = useState<string>("");

  const [maxPages, setMaxPages] = useState<number>(200);
  const [concurrency, setConcurrency] = useState<number>(10);
  const [timeoutSecs] = useState<number>(10);

  const [status, setStatus] = useState<AuditStatus>("idle");
  const [results, setResults] = useState<Map<number, BatchRowOutput>>(new Map());
  const [currentProgress, setCurrentProgress] = useState<string>("");

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

    try {
      await auditBatch(
        batchInputs,
        maxPages,
        timeoutSecs,
        concurrency,
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
  const handleExport = (format: "csv" | "xlsx") => {
    if (rows.length === 0) return;

    const enrichedRows = rows.map((row, idx) => {
      const res = results.get(idx);
      const out = { ...row };

      // Update email column
      if (emailCol) {
        out[emailCol] = res ? res.updatedEmail : (row[emailCol] || "");
      }

      // Add "website audit" column
      out["website audit"] = res ? res.websiteAudit : (row[websiteCol]?.trim() ? "Pending" : "no website");

      return out;
    });

    const baseName = fileName.replace(/\.[^/.]+$/, "");
    const exportName = `${baseName}-enriched.${format}`;

    if (format === "csv") {
      // Include UTF-8 BOM so Excel opens special characters correctly
      const csvStr = "\uFEFF" + Papa.unparse(enrichedRows);
      const blob = new Blob([csvStr], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportName;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const ws = XLSX.utils.json_to_sheet(enrichedRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Enriched Data");
      XLSX.writeFile(wb, exportName);
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

  results.forEach((r) => {
    if (r.status === "success") successCount++;
    else if (r.status === "skipped") skippedCount++;
    else if (r.status === "error") errorCount++;
    if (r.emailsFound && r.emailsFound.length > 0) {
      newEmailsCount += r.emailsFound.length;
    }
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
                  MAX PAGES PER SITE
                </label>
                <select
                  className="input"
                  value={maxPages}
                  disabled={status === "running"}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  style={{ width: "100%" }}
                >
                  <option value={25}>25 pages (Quick Sample)</option>
                  <option value={50}>50 pages (Standard Crawl)</option>
                  <option value={100}>100 pages (Deep Crawl)</option>
                  <option value={200}>200 pages (Full Site Audit - Recommended)</option>
                  <option value={500}>500 pages (Comprehensive Audit)</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
                  CONCURRENT WORKERS
                </label>
                <select
                  className="input"
                  value={concurrency}
                  disabled={status === "running"}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  style={{ width: "100%" }}
                >
                  <option value={5}>5 websites at once</option>
                  <option value={10}>10 websites at once (Balanced)</option>
                  <option value={15}>15 websites at once (High Speed)</option>
                  <option value={25}>25 websites at once (Turbo)</option>
                </select>
              </div>
            </div>

            {/* Audit Engine Features Badge Strip */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                fontSize: 12,
                color: "var(--muted)",
                padding: "8px 12px",
                background: "var(--bg)",
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✓ Broken Link Checking (External & Internal)</span>
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✓ Sitemap.xml Seeding</span>
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✓ Robots.txt Verification</span>
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✓ Email & Contact Scraping</span>
              <span style={{ color: "var(--green)", fontWeight: 500 }}>✓ Generative Engine (GEO) & Schema Audit</span>
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
                  disabled={processedCount === 0}
                  onClick={() => handleExport("csv")}
                  title="Download enriched CSV with new emails and website audit"
                >
                  <Download size={14} style={{ marginRight: 6 }} />
                  Download CSV
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={processedCount === 0}
                  onClick={() => handleExport("xlsx")}
                  title="Download enriched Excel (.xlsx) file"
                >
                  <Download size={14} style={{ marginRight: 6 }} />
                  Download Excel (.xlsx)
                </button>
              </div>
            </div>
          </div>

          {/* Progress & Metrics Dashboard */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 24 }}>
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
          </div>

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

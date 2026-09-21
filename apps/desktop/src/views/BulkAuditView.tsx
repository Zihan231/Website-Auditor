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
  Pause,
  X,
  Layers,
  Activity,
  Copy,
  Check,
  FolderOpen,
} from "lucide-react";
import {
  auditBatch,
  cancelBatch,
  cancelBatchSite,
  isTauri,
  listenForPdfEvents,
  openExternal,
  pickFolder,
  pickSavePath,
  revealFileInFolder,
  saveFileBytes,
  type BatchRowInput,
  type BatchRowOutput,
  type BatchSiteProgress,
  type BatchPdfProgress,
} from "../lib/api";
import type { CrawlConfig, UrlFilter } from "../lib/types";
import { DEFAULT_CONFIG } from "../lib/types";
import { getCrawlDefaults } from "../lib/crawl-defaults";
import { IconChevron, Toggle } from "../components/ui";

type AuditStatus = "idle" | "running" | "done" | "cancelled" | "paused";

/** Marks a row as interrupted by a user pause (vs. a genuine per-site error)
 *  so Resume knows which rows to retry. Same string `cancel_batch` already
 *  produces for an in-flight row — pausing just reuses that primitive and
 *  gives the result a different status label in the UI. */
const PAUSED_MARKER = "Error: Cancelled";

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

interface ValidatedNumberInputProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (val: number) => void;
  hint?: string;
  placeholder?: string;
}

function ValidatedNumberInput({
  label,
  value,
  min = 0,
  max,
  disabled,
  onChange,
  hint,
  placeholder,
}: ValidatedNumberInputProps) {
  const [text, setText] = useState<string>(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(String(value));
    setError(null);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    const trimmed = raw.trim();

    if (trimmed === "") {
      setError("Number required");
      return;
    }

    // Real-time verification: check if input contains non-digits
    if (!/^\d+$/.test(trimmed)) {
      setError("Digits only (0-9)");
      return;
    }

    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      setError("Invalid number");
      return;
    }

    if (num < min) {
      setError(`Minimum is ${min}`);
      return;
    }

    if (max !== undefined && num > max) {
      setError(`Maximum is ${max}`);
      return;
    }

    setError(null);
    onChange(num);
  };

  const handleBlur = () => {
    const trimmed = text.trim();
    if (error || trimmed === "" || !/^\d+$/.test(trimmed)) {
      const fallback = Math.max(min, Number(trimmed) || min);
      setText(String(fallback));
      setError(null);
      onChange(fallback);
    }
  };

  return (
    <div className="field" style={{ position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: error ? "var(--red-text, #ef4444)" : "var(--text)" }}>
          {label}
        </label>
        {error && (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: "var(--red-text, #ef4444)",
              background: "rgba(239, 68, 68, 0.1)",
              padding: "1px 6px",
              borderRadius: 4,
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            <AlertCircle size={10} /> {error}
          </span>
        )}
      </div>
      <input
        type="text"
        inputMode="numeric"
        className="input input-sm mono"
        disabled={disabled}
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder ?? String(min)}
        style={{
          width: "100%",
          background: "var(--bg)",
          borderColor: error ? "var(--red, #ef4444)" : undefined,
          boxShadow: error ? "0 0 0 1px rgba(239, 68, 68, 0.25)" : undefined,
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
        }}
      />
      {hint && !error && (
        <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, display: "block" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function BulkAuditView({ onBack }: { onBack?: () => void }) {
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);

  const [websiteCol, setWebsiteCol] = useState<string>("");
  const [emailCol, setEmailCol] = useState<string>("");

  // Full crawl config, shared by every row (each row just re-targets `url`)
  const [cfg, setCfg] = useState<CrawlConfig>(() => ({ ...DEFAULT_CONFIG, ...getCrawlDefaults(), maxPages: 200 }));
  const [rowConcurrency, setRowConcurrency] = useState<number>(10);
  const [pdfDir, setPdfDir] = useState<string | null>(null);
  const [maxRamMb, setMaxRamMb] = useState<number>(1500);
  const [advanced, setAdvanced] = useState(false);
  const [hostsText, setHostsText] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [hostsRegex, setHostsRegex] = useState(false);
  const [pathsRegex, setPathsRegex] = useState(false);

  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  const set = <K extends keyof CrawlConfig>(key: K, v: CrawlConfig[K]) => setCfg({ ...cfg, [key]: v });
  const numField = (label: string, key: keyof CrawlConfig, min = 1, hint?: string) => (
    <ValidatedNumberInput
      label={label}
      value={cfg[key] as number}
      min={min}
      disabled={status === "running"}
      onChange={(v) => set(key, v as CrawlConfig[typeof key])}
      hint={hint}
    />
  );

  const [status, setStatus] = useState<AuditStatus>("idle");
  const [results, setResults] = useState<Map<number, BatchRowOutput>>(new Map());
  const [activeSites, setActiveSites] = useState<Map<string, BatchSiteProgress>>(new Map());
  const [activePdfs, setActivePdfs] = useState<Map<string, BatchPdfProgress>>(new Map());
  const [cancellingUrls, setCancellingUrls] = useState<Set<string>>(new Set());
  const [currentProgress, setCurrentProgress] = useState<string>("");
  const [pdfWarning, setPdfWarning] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<"csv" | "xlsx" | null>(null);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<{ path: string; format: string } | null>(null);
  const [exportErrorMsg, setExportErrorMsg] = useState<string | null>(null);

  // PDF reports listener
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
      (message) => setPdfWarning(message),
      (progress) => {
        setActivePdfs((prev) => {
          const next = new Map(prev);
          if (progress.status === "completed" || progress.status === "error") {
            next.delete(progress.url);
          } else {
            next.set(progress.url, progress);
          }
          return next;
        });
      }
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
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "skipped" | "error" | "emails" | "pdf">("all");

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

  // Sample detected values
  const sampleWebsite = useMemo(() => {
    if (!websiteCol || rows.length === 0) return "";
    const found = rows.find((r) => r[websiteCol] && String(r[websiteCol]).trim());
    return found ? String(found[websiteCol]).trim() : "";
  }, [rows, websiteCol]);

  const sampleEmail = useMemo(() => {
    if (!emailCol || rows.length === 0) return "";
    const found = rows.find((r) => r[emailCol] && String(r[emailCol]).trim());
    return found ? String(found[emailCol]).trim() : "";
  }, [rows, emailCol]);

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

  // Runs batch
  const runBatch = async (batchInputs: BatchRowInput[], totalForProgress: number) => {
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
        maxRamMb,
        (completedRow) => {
          setResults((prev) => {
            const next = new Map(prev);
            next.set(completedRow.index, completedRow);
            return next;
          });
          setActiveSites((prev) => {
            let modified = false;
            const next = new Map(prev);
            for (const [url, siteProg] of prev.entries()) {
              if (siteProg.indices.includes(completedRow.index)) {
                const remaining = siteProg.indices.filter((i) => i !== completedRow.index);
                if (remaining.length === 0) {
                  next.delete(url);
                  modified = true;
                } else {
                  next.set(url, { ...siteProg, indices: remaining });
                  modified = true;
                }
              }
            }
            return modified ? next : prev;
          });
          setCurrentProgress(`Processed row ${completedRow.index + 1} of ${totalForProgress} (${completedRow.website || "no website"})`);
        },
        (progress) => {
          setActiveSites((prev) => {
            const next = new Map(prev);
            if (progress.status === "completed" || progress.status === "error" || progress.status === "cancelled") {
              next.delete(progress.url);
            } else {
              next.set(progress.url, progress);
            }
            return next;
          });
        }
      );
      setStatus("done");
      setActiveSites(new Map());
      setCurrentProgress("Audit complete!");
    } catch (err) {
      setStatus("done");
      setActiveSites(new Map());
      setCurrentProgress(`Batch ended: ${String(err)}`);
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
    setActiveSites(new Map());
    setActivePdfs(new Map());
    setCurrentProgress("Initializing batch...");

    const batchInputs: BatchRowInput[] = rows.map((row, idx) => ({
      index: idx,
      website: String(row[websiteCol] || ""),
      currentEmail: emailCol ? String(row[emailCol] || "") : undefined,
    }));

    await runBatch(batchInputs, batchInputs.length);
  };

  // Pause
  const handlePause = async () => {
    await cancelBatch();
    setStatus("paused");
    setActiveSites(new Map());
    setActivePdfs(new Map());
    setCurrentProgress("Paused — click Resume to continue from where you left off.");
  };

  // Resume
  const handleResume = async () => {
    if (!websiteCol) return;

    const remaining = rows
      .map((row, idx) => ({ row, idx }))
      .filter(({ idx }) => {
        const res = results.get(idx);
        return !res || res.websiteAudit === PAUSED_MARKER;
      })
      .map(({ row, idx }) => ({
        index: idx,
        website: String(row[websiteCol] || ""),
        currentEmail: emailCol ? String(row[emailCol] || "") : undefined,
      }));

    if (remaining.length === 0) {
      setStatus("done");
      setCurrentProgress("All rows already completed.");
      return;
    }

    setStatus("running");
    setActiveSites(new Map());
    setActivePdfs(new Map());
    setCurrentProgress(`Resuming ${remaining.length} remaining rows...`);

    await runBatch(remaining, rows.length);
  };

  // Stop / Cancel
  const handleCancel = async () => {
    await cancelBatch();
    setStatus("cancelled");
    setActiveSites(new Map());
    setActivePdfs(new Map());
    setCancellingUrls(new Set());
    setCurrentProgress("Audit cancelled by user.");
  };

  // Cancel an individual website
  const handleCancelSite = async (url: string) => {
    setCancellingUrls((prev) => new Set(prev).add(url));
    try {
      await cancelBatchSite(url);
    } catch (err) {
      console.error("Failed to cancel site:", err);
    }
  };

  // Skip row directly
  const handleSkipRow = async (rowIdx: number, website: string) => {
    const trimmed = website.trim();
    if (trimmed) {
      setCancellingUrls((prev) => new Set(prev).add(trimmed));
      try {
        await cancelBatchSite(trimmed);
      } catch (err) {
        console.error("Failed to cancel site:", err);
      }
    }
    setResults((prev) => {
      const next = new Map(prev);
      next.set(rowIdx, {
        index: rowIdx,
        website: trimmed,
        updatedEmail: "",
        websiteAudit: "Cancelled: Skipped by user",
        emailsFound: [],
        status: "skipped",
        pdfPath: null,
      });
      if (trimmed && websiteCol) {
        rows.forEach((r, idx) => {
          if (r[websiteCol]?.trim() === trimmed && !next.has(idx)) {
            next.set(idx, {
              index: idx,
              website: trimmed,
              updatedEmail: "",
              websiteAudit: "Cancelled: Skipped by user",
              emailsFound: [],
              status: "skipped",
              pdfPath: null,
            });
          }
        });
      }
      return next;
    });
    setActiveSites((prev) => {
      let modified = false;
      const next = new Map(prev);
      for (const [url, prog] of prev.entries()) {
        if (url === trimmed || url.includes(trimmed) || prog.indices.includes(rowIdx)) {
          next.delete(url);
          modified = true;
        }
      }
      return modified ? next : prev;
    });
  };

  // Export Enriched File
  const handleExport = async (format: "csv" | "xlsx") => {
    if (rows.length === 0 || exportingFormat !== null) return;

    setExportErrorMsg(null);
    setExportSuccessMsg(null);

    const baseName = fileName.replace(/\.[^/.]+$/, "") || "audit-leads";
    const defaultExportName = `${baseName}-enriched.${format}`;

    let savePath: string | null = null;
    if (isTauri()) {
      savePath = await pickSavePath({
        defaultPath: defaultExportName,
        filters: format === "csv" ? [{ name: "CSV", extensions: ["csv"] }] : [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!savePath) return;
    }

    setExportingFormat(format);

    try {
      const enrichedRows = rows.map((row, idx) => {
        const res = results.get(idx);
        const newRow: Record<string, any> = { ...row };

        if (emailCol) {
          newRow[emailCol] = res ? res.updatedEmail : row[emailCol];
        }

        newRow["website audit"] = res ? res.websiteAudit : "pending";
        newRow["emails found"] = res && res.emailsFound.length > 0 ? res.emailsFound.join("; ") : "";
        newRow["audit status"] = res ? res.status : "pending";
        newRow["pdf report"] = res && res.pdfPath ? res.pdfPath : "";

        return newRow;
      });

      if (format === "csv") {
        const csvStr = Papa.unparse(enrichedRows);
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
        const sanitizedRows = enrichedRows.map((row) => {
          const clean: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            clean[key] = truncateCellForSpreadsheet(value);
          }
          return clean;
        });

        const ws = XLSX.utils.json_to_sheet(sanitizedRows);
        const cols = Object.keys(enrichedRows[0] ?? {});
        const pdfColIdx = cols.indexOf("pdf report");
        if (pdfColIdx >= 0) {
          enrichedRows.forEach((r, i) => {
            const p = r["pdf report"];
            if (!p) return;
            const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: pdfColIdx });
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

  const copyEmailToClipboard = (email: string) => {
    navigator.clipboard.writeText(email);
    setCopiedEmail(email);
    setTimeout(() => setCopiedEmail(null), 2000);
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

  const emailsRowsCount = useMemo(() => {
    let c = 0;
    results.forEach((r) => {
      if (r.emailsFound && r.emailsFound.length > 0) c++;
    });
    return c;
  }, [results]);

  // Filtered rows for preview table
  const previewRows = useMemo(() => {
    return rows
      .map((row, idx) => ({ row, idx, result: results.get(idx) }))
      .filter(({ row, result }) => {
        if (statusFilter === "success") {
          if (!result || result.status !== "success") return false;
        } else if (statusFilter === "skipped") {
          if (!result || result.status !== "skipped") return false;
        } else if (statusFilter === "error") {
          if (!result || result.status !== "error") return false;
        } else if (statusFilter === "emails") {
          if (!result || !result.emailsFound || result.emailsFound.length === 0) return false;
        } else if (statusFilter === "pdf") {
          if (!result || !result.pdfPath) return false;
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
    <div style={{ padding: "28px 32px 60px", maxWidth: 1360, margin: "0 auto" }}>
      {/* Top Banner & Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 24,
          padding: "20px 24px",
          borderRadius: 14,
          background: "linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(14, 165, 233, 0.05) 50%, rgba(16, 185, 129, 0.05) 100%)",
          border: "1px solid rgba(99, 102, 241, 0.2)",
          boxShadow: "0 2px 10px rgba(0, 0, 0, 0.02)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "linear-gradient(135deg, #6366f1 0%, #3b82f6 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
            }}
          >
            <FileSpreadsheet size={22} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
                Bulk CSV / Excel Audit & Email Enrichment
              </h1>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "2px 8px",
                  borderRadius: 6,
                  background:
                    status === "running"
                      ? "rgba(16, 185, 129, 0.15)"
                      : status === "paused"
                      ? "rgba(245, 158, 11, 0.15)"
                      : status === "done"
                      ? "rgba(59, 130, 246, 0.15)"
                      : "rgba(99, 102, 241, 0.12)",
                  color:
                    status === "running"
                      ? "var(--green-text, #10b981)"
                      : status === "paused"
                      ? "var(--amber-text, #f59e0b)"
                      : status === "done"
                      ? "var(--blue, #3b82f6)"
                      : "#6366f1",
                  border: `1px solid ${
                    status === "running"
                      ? "rgba(16, 185, 129, 0.3)"
                      : status === "paused"
                      ? "rgba(245, 158, 11, 0.3)"
                      : status === "done"
                      ? "rgba(59, 130, 246, 0.3)"
                      : "rgba(99, 102, 241, 0.25)"
                  }`,
                }}
              >
                {status === "running"
                  ? "● Live Engine Active"
                  : status === "paused"
                  ? "❚❚ Batch Paused"
                  : status === "done"
                  ? "✓ Audit Finished"
                  : "Ready for Batch"}
              </span>
            </div>
            <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 13.5 }}>
              Crawl thousands of websites in parallel, discover verified contact emails, and produce branded client PDF audit reports.
            </p>
          </div>
        </div>

        {onBack && (
          <button className="btn btn-secondary" onClick={onBack}>
            Back
          </button>
        )}
      </div>

      {/* File Upload Dropzone (when no rows loaded) */}
      {rows.length === 0 ? (
        <div style={{ display: "grid", gap: 24 }}>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: "2px dashed #6366f1",
              borderRadius: 16,
              padding: "54px 28px",
              textAlign: "center",
              cursor: "pointer",
              background: "linear-gradient(180deg, rgba(99, 102, 241, 0.04) 0%, var(--surface) 100%)",
              boxShadow: "0 4px 20px rgba(99, 102, 241, 0.06)",
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
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "rgba(99, 102, 241, 0.12)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#6366f1",
                marginBottom: 16,
              }}
            >
              <UploadCloud size={32} />
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
              Import Lead List (.CSV or .XLSX)
            </h2>
            <p style={{ color: "var(--text-secondary)", margin: "0 0 16px", fontSize: 14, maxWidth: 500, marginInline: "auto" }}>
              Drag & drop your file here or click to browse. Handles 1 to 10,000+ domains with automatic column recognition.
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 20 }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 6, background: "rgba(99, 102, 241, 0.1)", color: "#6366f1" }}>
                .CSV (Comma Separated)
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 6, background: "rgba(16, 185, 129, 0.1)", color: "#10b981" }}>
                .XLSX / .XLS (Excel)
              </span>
            </div>
            <button className="btn btn-primary" type="button" style={{ padding: "10px 24px", fontSize: 14, fontWeight: 600 }}>
              Browse Files
            </button>
          </div>

          {/* Workflow Guide Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            <div style={{ padding: "18px 20px", borderRadius: 12, background: "rgba(99, 102, 241, 0.05)", border: "1px solid rgba(99, 102, 241, 0.18)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, color: "#6366f1", fontWeight: 700, fontSize: 14 }}>
                <Globe size={18} /> 1. Target Websites
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                Map your website column. Crawlie tests HTTP health, SEO, meta tags, and accessibility in parallel.
              </p>
            </div>
            <div style={{ padding: "18px 20px", borderRadius: 12, background: "rgba(6, 182, 212, 0.05)", border: "1px solid rgba(6, 182, 212, 0.2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, color: "#06b6d4", fontWeight: 700, fontSize: 14 }}>
                <Mail size={18} /> 2. Lead Discovery
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                Deep-scans headers, contact pages, and mailto links to extract verified decision-maker emails.
              </p>
            </div>
            <div style={{ padding: "18px 20px", borderRadius: 12, background: "rgba(236, 72, 153, 0.05)", border: "1px solid rgba(236, 72, 153, 0.2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, color: "#ec4899", fontWeight: 700, fontSize: 14 }}>
                <FileText size={18} /> 3. Branded PDF Reports
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                4 parallel Chrome tabs render beautiful, client-ready pitch PDFs saved directly to your disk.
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* Configuration & Operations Hub */
        <div>
          {/* SECTION 1: Dataset & Column Alignment (Indigo Theme) */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid rgba(99, 102, 241, 0.25)",
              borderTop: "4px solid #6366f1",
              borderRadius: 14,
              padding: "20px 24px",
              marginBottom: 20,
              boxShadow: "0 2px 10px rgba(99, 102, 241, 0.04)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "#6366f1", color: "#ffffff" }}>
                  STEP 1
                </span>
                <span style={{ fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)" }}>
                  Dataset & Column Alignment
                </span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>•</span>
                <span style={{ fontSize: 13, color: "#6366f1", fontWeight: 600 }}>{fileName}</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  ({totalRows.toLocaleString()} rows · {headers.length} columns)
                </span>
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
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
                >
                  <RefreshCw size={13} />
                  Change File
                </button>
              )}
            </div>

            {/* Column Selector Cards with Live Sample Detection */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
              {/* Website Column */}
              <div
                style={{
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                    <Globe size={14} style={{ color: "#3b82f6" }} />
                    WEBSITE URL COLUMN <span style={{ color: "var(--red-text)" }}>*</span>
                  </label>
                  {websiteCol && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#10b981", background: "rgba(16, 185, 129, 0.12)", padding: "1px 6px", borderRadius: 4 }}>
                      ✓ MAPPED
                    </span>
                  )}
                </div>
                <select
                  className="input"
                  value={websiteCol}
                  disabled={status === "running"}
                  onChange={(e) => setWebsiteCol(e.target.value)}
                  style={{ width: "100%", background: "var(--bg)", fontWeight: 500 }}
                >
                  <option value="">-- Select Column Containing URLs --</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: 6, fontSize: 11.5, color: sampleWebsite ? "var(--text-secondary)" : "var(--amber-text)", display: "flex", alignItems: "center", gap: 6 }}>
                  {sampleWebsite ? (
                    <>
                      <span style={{ color: "var(--text-tertiary)" }}>Sample:</span>
                      <code className="mono" style={{ color: "#3b82f6", fontWeight: 600 }}>{sampleWebsite}</code>
                    </>
                  ) : (
                    "⚠️ Please select the column containing website links"
                  )}
                </div>
              </div>

              {/* Email Column */}
              <div
                style={{
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                    <Mail size={14} style={{ color: "#06b6d4" }} />
                    EMAIL COLUMN (TO ENRICH)
                  </label>
                  {emailCol ? (
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#06b6d4", background: "rgba(6, 182, 212, 0.12)", padding: "1px 6px", borderRadius: 4 }}>
                      ✓ ENRICHING
                    </span>
                  ) : (
                    <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text-tertiary)" }}>OPTIONAL</span>
                  )}
                </div>
                <select
                  className="input"
                  value={emailCol}
                  disabled={status === "running"}
                  onChange={(e) => setEmailCol(e.target.value)}
                  style={{ width: "100%", background: "var(--bg)", fontWeight: 500 }}
                >
                  <option value="">-- None (Auto-create new email column) --</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                  {sampleEmail ? (
                    <>
                      <span style={{ color: "var(--text-tertiary)" }}>Sample:</span>
                      <code className="mono" style={{ color: "#06b6d4", fontWeight: 600 }}>{sampleEmail}</code>
                    </>
                  ) : (
                    "Emails discovered on websites will be saved into the output"
                  )}
                </div>
              </div>

              {/* PDF Output Directory */}
              <div
                style={{
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                    <FileText size={14} style={{ color: "#ec4899" }} />
                    PDF REPORT DIRECTORY
                  </label>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "#ec4899", background: "rgba(236, 72, 153, 0.12)", padding: "1px 6px", borderRadius: 4 }}>
                    AUTO-SAVE
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={status === "running"}
                    onClick={async () => {
                      const dir = await pickFolder();
                      if (dir) setPdfDir(dir);
                    }}
                    style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Folder size={13} />
                    Choose Folder…
                  </button>
                  {pdfDir && (
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={status === "running"}
                      title="Reset to default (Downloads)"
                      onClick={() => setPdfDir(null)}
                      style={{ padding: 4 }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Target: <strong style={{ color: "var(--text)" }}>{pdfDir ?? "Downloads/crawlie-pdf-reports (default)"}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* SECTION 2: Engine Performance & Crawl Limits (Amber & Cyan Theme) */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid rgba(245, 158, 11, 0.25)",
              borderTop: "4px solid #f59e0b",
              borderRadius: 14,
              padding: "20px 24px",
              marginBottom: 20,
              boxShadow: "0 2px 10px rgba(245, 158, 11, 0.03)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "#f59e0b", color: "#ffffff" }}>
                STEP 2
              </span>
              <span style={{ fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)" }}>
                Crawl Engine & Performance Limits
              </span>
            </div>

            {/* Performance Sliders & Controls */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
                  ⚡ WEBSITES IN PARALLEL
                </label>
                <select
                  className="input"
                  value={rowConcurrency}
                  disabled={status === "running"}
                  onChange={(e) => setRowConcurrency(Number(e.target.value))}
                  style={{ width: "100%", background: "var(--bg)", fontWeight: 500 }}
                >
                  <option value={5}>5 websites at once (Gentle)</option>
                  <option value={10}>10 websites at once (Balanced)</option>
                  <option value={15}>15 websites at once (Fast)</option>
                  <option value={25}>25 websites at once (Turbo)</option>
                </select>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, display: "block" }}>
                  How many sites audit simultaneously
                </span>
              </div>

              <ValidatedNumberInput
                label="🛡️ RAM CEILING (MB)"
                value={maxRamMb}
                min={0}
                disabled={status === "running"}
                onChange={(v) => setMaxRamMb(v)}
                hint="Pauses new sites if app reaches this RAM (0 to disable)"
              />

              {numField("MAX PAGES / SITE", "maxPages", 1, "Page crawl cap per domain")}
              {numField("MAX DEPTH", "maxDepth", 0, "Link crawl depth (0 = homepage only)")}
              {numField("CONCURRENCY / SITE", "concurrency", 1, "Simultaneous requests per site")}
              {numField("TIMEOUT (S)", "timeoutSecs", 1, "HTTP response timeout in seconds")}
            </div>

            {/* Feature Toggles */}
            <div className="audit-toggles" style={{ display: "flex", flexWrap: "wrap", gap: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
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
                hint="Audit pages with headless Chrome for React/Next sites."
              />
            </div>

            {/* Advanced Exclusions */}
            <div className="audit-advanced" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="disclosure"
                onClick={() => setAdvanced(!advanced)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  color: "var(--text-secondary)",
                  fontSize: 12.5,
                  fontWeight: 500,
                }}
              >
                <span style={{ display: "inline-flex", transform: advanced ? "rotate(90deg)" : "none", transition: "transform 150ms" }}>
                  <IconChevron size={14} />
                </span>
                Advanced Exclusions & User Agent
              </button>

              {advanced && (
                <div className="advanced-panel" style={{ marginTop: 12, display: "grid", gap: 16, padding: "16px", borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                  <div className="field">
                    <label style={{ fontSize: 12, fontWeight: 600 }}>User Agent</label>
                    <input
                      className="input input-sm mono"
                      style={{ width: "100%", background: "var(--bg)" }}
                      disabled={status === "running"}
                      value={cfg.userAgent}
                      onChange={(e) => set("userAgent", e.target.value)}
                      placeholder="crawlie/…"
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div className="exclude-group">
                      <div className="exclude-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <label style={{ fontSize: 12, fontWeight: 600 }}>Excluded Hosts</label>
                        <label className="regex-inline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
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
                        style={{ height: 64, padding: 8, resize: "vertical", width: "100%", background: "var(--bg)", fontSize: 12 }}
                        disabled={status === "running"}
                        placeholder={hostsRegex ? "^ads\\.\nfacebook\\.com$" : "twitter.com\nfacebook"}
                        value={hostsText}
                        onChange={(e) => setHostsText(e.target.value)}
                      />
                    </div>

                    <div className="exclude-group">
                      <div className="exclude-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <label style={{ fontSize: 12, fontWeight: 600 }}>Excluded Paths</label>
                        <label className="regex-inline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
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
                        style={{ height: 64, padding: 8, resize: "vertical", width: "100%", background: "var(--bg)", fontSize: 12 }}
                        disabled={status === "running"}
                        placeholder={pathsRegex ? "\\.php$\n^/cart" : "/share\n/cart"}
                        value={pathsText}
                        onChange={(e) => setPathsText(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ACTION COMMAND BAR */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "16px 20px",
              borderRadius: 14,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.03)",
              marginBottom: 24,
            }}
          >
            {/* Primary Run Controls */}
            <div style={{ display: "flex", gap: 12 }}>
              {status === "running" && (
                <>
                  <button
                    className="btn btn-secondary"
                    onClick={handlePause}
                    style={{ background: "#f59e0b", color: "#ffffff", borderColor: "#d97706", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Pause size={15} />
                    Pause Batch
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={handleCancel}
                    style={{ background: "#e11d48", color: "#ffffff", borderColor: "#be123c", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Square size={15} />
                    Stop / Cancel
                  </button>
                </>
              )}
              {status === "paused" && (
                <>
                  <button
                    className="btn btn-primary"
                    onClick={handleResume}
                    style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", borderColor: "#059669", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Play size={15} />
                    Resume Batch
                  </button>
                  <button className="btn btn-danger" onClick={handleCancel} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Square size={15} />
                    Stop / Cancel
                  </button>
                </>
              )}
              {status !== "running" && status !== "paused" && (
                <button
                  className="btn btn-primary"
                  onClick={handleStart}
                  style={{
                    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                    borderColor: "#059669",
                    padding: "10px 24px",
                    fontSize: 14,
                    fontWeight: 700,
                    boxShadow: "0 4px 14px rgba(16, 185, 129, 0.35)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Play size={16} />
                  {status === "done" || status === "cancelled" ? "Re-Run Bulk Audit" : "Start Bulk Audit"}
                </button>
              )}
            </div>

            {/* Export Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className="btn btn-secondary"
                disabled={processedCount === 0 || exportingFormat !== null}
                onClick={() => handleExport("csv")}
                style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}
                title="Save enriched CSV with discovered emails and audit links"
              >
                {exportingFormat === "csv" ? (
                  <>
                    <RefreshCw size={14} style={{ animation: "spin 1s linear infinite" }} />
                    Saving CSV…
                  </>
                ) : (
                  <>
                    <Download size={14} style={{ color: "#10b981" }} />
                    Export CSV
                  </>
                )}
              </button>
              <button
                className="btn btn-secondary"
                disabled={processedCount === 0 || exportingFormat !== null}
                onClick={() => handleExport("xlsx")}
                style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}
                title="Save formatted Excel (.xlsx) with clickable PDF links"
              >
                {exportingFormat === "xlsx" ? (
                  <>
                    <RefreshCw size={14} style={{ animation: "spin 1s linear infinite" }} />
                    Saving Excel…
                  </>
                ) : (
                  <>
                    <FileSpreadsheet size={14} style={{ color: "#3b82f6" }} />
                    Export Excel (.xlsx)
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Export Notifications */}
          {exportSuccessMsg && (
            <div
              style={{
                marginBottom: 20,
                padding: "12px 18px",
                borderRadius: 10,
                background: "rgba(16, 185, 129, 0.12)",
                border: "1px solid rgba(16, 185, 129, 0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 13.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CheckCircle2 size={18} style={{ color: "#10b981", flexShrink: 0 }} />
                <span>
                  <strong>{exportSuccessMsg.format} File Saved:</strong>{" "}
                  <code className="mono" style={{ color: "#10b981", fontWeight: 600 }}>{exportSuccessMsg.path}</code>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {isTauri() && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: 12, padding: "4px 12px", background: "var(--bg)", display: "flex", alignItems: "center", gap: 5 }}
                    onClick={() => revealFileInFolder(exportSuccessMsg.path)}
                  >
                    <FolderOpen size={13} />
                    Show in Folder
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  style={{ padding: 4, background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}
                  onClick={() => setExportSuccessMsg(null)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {exportErrorMsg && (
            <div
              style={{
                marginBottom: 20,
                padding: "12px 18px",
                borderRadius: 10,
                background: "rgba(239, 68, 68, 0.12)",
                border: "1px solid rgba(239, 68, 68, 0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 13.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <AlertCircle size={18} style={{ color: "#ef4444", flexShrink: 0 }} />
                <span>{exportErrorMsg}</span>
              </div>
              <button
                type="button"
                className="icon-btn"
                style={{ padding: 4, background: "transparent", border: "none", cursor: "pointer" }}
                onClick={() => setExportErrorMsg(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* SECTION 3: Real-Time Progress & Color-Coded KPI Cards */}
          <div style={{ marginBottom: 24 }}>
            {/* Progress Bar Header */}
            {status === "running" && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, fontWeight: 500 }}>
                  <span style={{ color: "var(--text)" }}>{currentProgress}</span>
                  <span style={{ color: "#3b82f6", fontWeight: 700 }}>{percentComplete}% Complete</span>
                </div>
                <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${percentComplete}%`,
                      background: "linear-gradient(90deg, #3b82f6, #06b6d4, #10b981)",
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </div>
            )}

            {/* 6 Color-Coded KPI Stat Tiles */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
              {/* Total Rows - Slate */}
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderLeft: "4px solid #64748b",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(0, 0, 0, 0.02)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    TOTAL ROWS
                  </span>
                  <Layers size={16} style={{ color: "#64748b" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, fontFamily: "var(--font-mono, monospace)" }}>
                  {totalRows.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>In imported file</div>
              </div>

              {/* Processed - Electric Blue */}
              <div
                style={{
                  background: "rgba(59, 130, 246, 0.04)",
                  border: "1px solid rgba(59, 130, 246, 0.25)",
                  borderLeft: "4px solid #3b82f6",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(59, 130, 246, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#3b82f6", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    PROCESSED
                  </span>
                  <Activity size={16} style={{ color: "#3b82f6" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: "#3b82f6", fontFamily: "var(--font-mono, monospace)" }}>
                  {processedCount.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{percentComplete}% of batch</div>
              </div>

              {/* Audited (Success) - Emerald Green */}
              <div
                style={{
                  background: "rgba(16, 185, 129, 0.04)",
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                  borderLeft: "4px solid #10b981",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(16, 185, 129, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#10b981", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    AUDITED (SUCCESS)
                  </span>
                  <CheckCircle2 size={16} style={{ color: "#10b981" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: "#10b981", fontFamily: "var(--font-mono, monospace)" }}>
                  {successCount.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>Health & SEO crawled</div>
              </div>

              {/* Emails Discovered - Cyan / Sky */}
              <div
                style={{
                  background: "rgba(6, 182, 212, 0.04)",
                  border: "1px solid rgba(6, 182, 212, 0.25)",
                  borderLeft: "4px solid #06b6d4",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(6, 182, 212, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#06b6d4", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    DISCOVERED EMAILS
                  </span>
                  <Mail size={16} style={{ color: "#06b6d4" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: "#06b6d4", fontFamily: "var(--font-mono, monospace)" }}>
                  {newEmailsCount.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>Across {emailsRowsCount} websites</div>
              </div>

              {/* PDFs Ready - Vivid Rose */}
              <div
                style={{
                  background: "rgba(236, 72, 153, 0.04)",
                  border: "1px solid rgba(236, 72, 153, 0.25)",
                  borderLeft: "4px solid #ec4899",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(236, 72, 153, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#ec4899", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    PDFs GENERATED
                  </span>
                  <FileText size={16} style={{ color: "#ec4899" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: "#ec4899", fontFamily: "var(--font-mono, monospace)" }}>
                  {pdfReadyCount.toLocaleString()} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-tertiary)" }}>/ {successCount}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  {pdfReadyCount === successCount && successCount > 0 ? "✓ 100% written to disk" : "Generating in background"}
                </div>
              </div>

              {/* No Website / Errors - Soft Amber */}
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.04)",
                  border: "1px solid rgba(245, 158, 11, 0.25)",
                  borderLeft: "4px solid #f59e0b",
                  borderRadius: 12,
                  padding: "16px 18px",
                  boxShadow: "0 2px 6px rgba(245, 158, 11, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: "#f59e0b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    SKIPPED / ERRORS
                  </span>
                  <AlertCircle size={16} style={{ color: "#f59e0b" }} />
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: "#f59e0b", fontFamily: "var(--font-mono, monospace)" }}>
                  {(skippedCount + errorCount).toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  {skippedCount} no-URL · {errorCount} errors
                </div>
              </div>
            </div>
          </div>

          {/* PDF pipeline warning */}
          {pdfWarning && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid #f59e0b",
                borderRadius: 10,
                padding: "12px 16px",
                marginBottom: 20,
                fontSize: 13,
                color: "var(--amber-text)",
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1 }}>{pdfWarning}</span>
              <button className="icon-btn" onClick={() => setPdfWarning(null)} title="Dismiss" style={{ color: "inherit" }}>
                <X size={14} />
              </button>
            </div>
          )}

          {/* SECTION 4: Live Crawl Radar (Emerald / Mint Theme) */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              borderTop: "4px solid #10b981",
              borderRadius: 14,
              padding: "18px 22px",
              marginBottom: 20,
              boxShadow: "0 2px 10px rgba(16, 185, 129, 0.04)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: status === "running" ? "#10b981" : "var(--text-tertiary)",
                    boxShadow: status === "running" ? "0 0 0 4px rgba(16, 185, 129, 0.25)" : "none",
                    animation: status === "running" ? "pb-pulse 1.8s infinite" : "none",
                  }}
                />
                <span style={{ fontWeight: 700, fontSize: 13.5, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)" }}>
                  Live Crawl Workers
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 8,
                    background: status === "running" ? "rgba(16, 185, 129, 0.15)" : "rgba(100, 116, 139, 0.12)",
                    color: status === "running" ? "#10b981" : "var(--text-secondary)",
                  }}
                >
                  {status === "running" ? `${activeSites.size} active in parallel` : "Standing by"}
                </span>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Slot capacity: up to <strong>{rowConcurrency} parallel sites</strong>
              </span>
            </div>

            {activeSites.size === 0 ? (
              <div
                style={{
                  padding: "22px 16px",
                  textAlign: "center",
                  border: "1px dashed var(--border)",
                  borderRadius: 10,
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  background: "var(--bg-subtle)",
                }}
              >
                {status === "running"
                  ? "Waiting for worker slots to pick up the next sites..."
                  : status === "paused"
                  ? "Batch paused. Click 'Resume Batch' above to continue auditing remaining sites."
                  : `No active crawl workers running. Click 'Start Bulk Audit' to crawl up to ${rowConcurrency} websites in parallel.`}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12 }}>
                {Array.from(activeSites.values()).map((site) => {
                  const domain = site.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
                  const isPausedRam = site.status === "paused_ram";
                  const isCancelling = cancellingUrls.has(site.url) || cancellingUrls.has(domain);
                  return (
                    <div
                      key={site.url}
                      style={{
                        background: "var(--bg)",
                        border: `1px solid ${isPausedRam ? "#f59e0b" : "rgba(16, 185, 129, 0.3)"}`,
                        borderRadius: 10,
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.02)",
                        opacity: isCancelling ? 0.5 : 1,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ overflow: "hidden", flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Globe size={13} style={{ color: "#10b981", flexShrink: 0 }} />
                            <span
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                color: "var(--text)",
                              }}
                              title={site.url}
                            >
                              {domain || site.url}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                            {site.indices.length > 1
                              ? `Rows #${site.indices.map((i) => i + 1).join(", #")}`
                              : `Row #${(site.indices[0] ?? 0) + 1}`}
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          <span
                            style={{
                              fontSize: 15,
                              fontWeight: 800,
                              fontFamily: "var(--font-mono, monospace)",
                              color: isCancelling ? "var(--text-tertiary)" : isPausedRam ? "#f59e0b" : "#10b981",
                            }}
                          >
                            {isCancelling ? "SKIP" : isPausedRam ? "WAIT" : `${site.percentage}%`}
                          </span>
                          <button
                            type="button"
                            className="icon-btn"
                            disabled={isCancelling}
                            onClick={() => handleCancelSite(site.url)}
                            title="Skip this website and start next"
                            style={{
                              padding: 3,
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              background: "var(--surface)",
                              color: "var(--text-secondary)",
                              cursor: isCancelling ? "default" : "pointer",
                            }}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Progress Bar */}
                      <div style={{ height: 6, background: "var(--surface)", borderRadius: 3, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.max(2, site.percentage)}%`,
                            background: isPausedRam ? "#f59e0b" : "linear-gradient(90deg, #06b6d4, #10b981)",
                            transition: "width 0.3s ease",
                            borderRadius: 3,
                          }}
                        />
                      </div>

                      {/* Bottom Path */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--text-secondary)" }}>
                        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                          {isPausedRam ? "Paused (RAM limit)" : `${site.crawled} / ${site.maxPages} pages`}
                        </span>
                        <span
                          style={{
                            maxWidth: 140,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontFamily: "var(--font-mono, monospace)",
                          }}
                          title={site.currentUrl || ""}
                        >
                          {site.currentUrl ? site.currentUrl.replace(/^https?:\/\/[^/]+/, "") || "/" : "Starting…"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION 5: Active PDF Publishing Studio (Rose / Fuchsia Theme) */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid rgba(236, 72, 153, 0.3)",
              borderTop: "4px solid #ec4899",
              borderRadius: 14,
              padding: "18px 22px",
              marginBottom: 20,
              boxShadow: "0 2px 10px rgba(236, 72, 153, 0.04)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: activePdfs.size > 0 ? "#ec4899" : "var(--text-tertiary)",
                    boxShadow: activePdfs.size > 0 ? "0 0 0 4px rgba(236, 72, 153, 0.25)" : "none",
                    animation: activePdfs.size > 0 ? "pb-pulse 1.8s infinite" : "none",
                  }}
                />
                <span style={{ fontWeight: 700, fontSize: 13.5, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)" }}>
                  Parallel PDF Generators
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 8,
                    background: activePdfs.size > 0 ? "rgba(236, 72, 153, 0.15)" : "rgba(100, 116, 139, 0.12)",
                    color: activePdfs.size > 0 ? "#ec4899" : "var(--text-secondary)",
                  }}
                >
                  {activePdfs.size > 0
                    ? `${activePdfs.size} rendering in parallel`
                    : status === "running"
                    ? "Standing by for finished audits"
                    : status === "done" && pdfReadyCount === successCount && successCount > 0
                    ? "All PDFs Completed"
                    : "Ready for batch"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-secondary)" }}>
                <span>Capacity: up to <strong>4 parallel Chrome tabs</strong></span>
                <span>•</span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>
                  {pdfReadyCount} of {successCount} ready ({Math.max(0, successCount - pdfReadyCount)} remaining)
                </span>
              </div>
            </div>

            {activePdfs.size === 0 ? (
              <div
                style={{
                  padding: "18px 16px",
                  textAlign: "center",
                  border: "1px dashed var(--border)",
                  borderRadius: 10,
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  background: "var(--bg-subtle)",
                }}
              >
                {pdfReadyCount === successCount && successCount > 0
                  ? "✓ All client PDF reports have been generated and saved to your target folder."
                  : status === "running"
                  ? "PDF workers (up to 4 parallel Chrome tabs) are standing by to render client reports as site audits finish…"
                  : "No active PDF renders. As website audits finish, up to 4 parallel Chrome tabs render client PDFs here in real time."}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12 }}>
                {Array.from(activePdfs.values()).map((pdf) => {
                  const domain = pdf.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
                  return (
                    <div
                      key={pdf.url}
                      style={{
                        background: "var(--bg)",
                        border: "1px solid rgba(236, 72, 153, 0.35)",
                        borderRadius: 10,
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        boxShadow: "0 2px 6px rgba(236, 72, 153, 0.06)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 180,
                            color: "var(--text)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                          title={pdf.url}
                        >
                          <FileText size={14} style={{ color: "#ec4899", flexShrink: 0 }} />
                          {domain}
                        </span>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            fontFamily: "var(--font-mono, monospace)",
                            color: "#ec4899",
                            background: "rgba(236, 72, 153, 0.12)",
                            padding: "2px 6px",
                            borderRadius: 4,
                          }}
                        >
                          PRINTING PDF
                        </span>
                      </div>

                      {/* Progress Bar (pulsing animated gradient) */}
                      <div style={{ height: 6, background: "var(--surface)", borderRadius: 3, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: "100%",
                            background: "linear-gradient(90deg, #ec4899, #f43f5e, #fb7185)",
                            borderRadius: 3,
                            animation: "pb-pulse 1.4s infinite",
                          }}
                        />
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--text-secondary)" }}>
                        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>Formatting layout…</span>
                        <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "var(--text-tertiary)" }}>Saving to folder</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION 6: Enriched Leads & Audit Records Table (Slate Theme) */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderTop: "4px solid #475569",
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 2px 10px rgba(0, 0, 0, 0.03)",
            }}
          >
            {/* Header & Filter Controls Bar */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)" }}>
                  Enriched Leads & Audit Records
                </span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  ({previewRows.length} of {totalRows} shown)
                </span>
              </div>

              {/* Segmented Filter Pills & Search */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {/* Status Filter Buttons */}
                <div style={{ display: "flex", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2, gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("all")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      borderRadius: 6,
                      background: statusFilter === "all" ? "var(--surface)" : "transparent",
                      color: statusFilter === "all" ? "var(--text)" : "var(--text-secondary)",
                      cursor: "pointer",
                      boxShadow: statusFilter === "all" ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                    }}
                  >
                    All ({totalRows})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("success")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      borderRadius: 6,
                      background: statusFilter === "success" ? "rgba(16, 185, 129, 0.15)" : "transparent",
                      color: statusFilter === "success" ? "#10b981" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    Audited ({successCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("emails")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      borderRadius: 6,
                      background: statusFilter === "emails" ? "rgba(6, 182, 212, 0.15)" : "transparent",
                      color: statusFilter === "emails" ? "#06b6d4" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    Emails Found ({emailsRowsCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("pdf")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      borderRadius: 6,
                      background: statusFilter === "pdf" ? "rgba(236, 72, 153, 0.15)" : "transparent",
                      color: statusFilter === "pdf" ? "#ec4899" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    PDFs Ready ({pdfReadyCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("error")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      borderRadius: 6,
                      background: statusFilter === "error" ? "rgba(239, 68, 68, 0.15)" : "transparent",
                      color: statusFilter === "error" ? "#ef4444" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    Errors ({errorCount})
                  </button>
                </div>

                {/* Instant Search Box */}
                <div style={{ position: "relative" }}>
                  <Search size={14} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-tertiary)" }} />
                  <input
                    type="text"
                    placeholder="Search records..."
                    className="input"
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    style={{ paddingLeft: 30, width: 170, height: 32, fontSize: 12.5, background: "var(--bg)" }}
                  />
                </div>
              </div>
            </div>

            {/* Table Content */}
            <div style={{ maxHeight: 520, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
                <thead>
                  <tr style={{ background: "var(--bg-2)", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                    <th style={{ padding: "11px 16px", width: 60, fontWeight: 700, fontSize: 12 }}>#</th>
                    <th style={{ padding: "11px 16px", width: 230, fontWeight: 700, fontSize: 12 }}>WEBSITE</th>
                    <th style={{ padding: "11px 16px", width: 240, fontWeight: 700, fontSize: 12 }}>ENRICHED CONTACT EMAIL</th>
                    <th style={{ padding: "11px 16px", fontWeight: 700, fontSize: 12 }}>AUDIT OVERVIEW & PDF</th>
                    <th style={{ padding: "11px 16px", width: 140, fontWeight: 700, fontSize: 12 }}>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 100).map(({ row, idx, result }) => {
                    const isExpanded = expandedIndex === idx;
                    const websiteVal = row[websiteCol] || "";
                    const trimmedWebsite = websiteVal.trim();
                    const emailVal = result ? result.updatedEmail : (row[emailCol] || "—");

                    const activeSiteInfo = Array.from(activeSites.values()).find(
                      (s) => s.indices.includes(idx) || (trimmedWebsite && s.url.includes(trimmedWebsite))
                    );
                    const isCancelling = cancellingUrls.has(trimmedWebsite) || (activeSiteInfo ? cancellingUrls.has(activeSiteInfo.url) : false);

                    return (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          background: isExpanded ? "var(--bg-subtle)" : "transparent",
                          transition: "background 0.15s ease",
                        }}
                      >
                        <td style={{ padding: "12px 16px", color: "var(--text-tertiary)", fontFamily: "var(--font-mono, monospace)" }}>
                          {idx + 1}
                        </td>
                        <td style={{ padding: "12px 16px", fontWeight: 600, wordBreak: "break-all" }}>
                          {websiteVal ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Globe size={14} style={{ color: "#3b82f6", flexShrink: 0 }} />
                              <span style={{ color: "var(--text)" }}>{websiteVal}</span>
                            </span>
                          ) : (
                            <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>no website</span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px", wordBreak: "break-all" }}>
                          {result?.emailsFound && result.emailsFound.length > 0 ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span
                                style={{
                                  background: "rgba(6, 182, 212, 0.12)",
                                  color: "#0891b2",
                                  border: "1px solid rgba(6, 182, 212, 0.3)",
                                  borderRadius: 6,
                                  padding: "2px 8px",
                                  fontWeight: 700,
                                  fontSize: 12,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 5,
                                }}
                              >
                                <Mail size={12} />
                                {emailVal}
                              </span>
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => copyEmailToClipboard(emailVal)}
                                title="Copy email address"
                                style={{ padding: 4, borderRadius: 4 }}
                              >
                                {copiedEmail === emailVal ? (
                                  <Check size={13} style={{ color: "#10b981" }} />
                                ) : (
                                  <Copy size={13} style={{ color: "var(--text-tertiary)" }} />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span style={{ color: emailVal === "—" ? "var(--text-tertiary)" : "var(--text)" }}>{emailVal}</span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {result ? (
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <button
                                  type="button"
                                  onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                                  style={{
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 5,
                                    background: "none",
                                    border: "none",
                                    padding: 0,
                                    color: result.status === "error" ? "var(--red-text)" : "#3b82f6",
                                    fontWeight: 600,
                                    fontSize: 12.5,
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  {result.status === "skipped"
                                    ? "no website"
                                    : result.status === "error"
                                    ? result.websiteAudit
                                    : "View Audit Breakdown"}
                                </button>
                                {result.status === "success" && (
                                  result.pdfPath ? (
                                    <button
                                      className="btn btn-secondary btn-sm"
                                      onClick={(e) => { e.stopPropagation(); void openExternal(result.pdfPath!); }}
                                      title="Open PDF audit report in browser"
                                      style={{
                                        padding: "2px 8px",
                                        fontSize: 11.5,
                                        fontWeight: 700,
                                        background: "rgba(236, 72, 153, 0.12)",
                                        color: "#ec4899",
                                        borderColor: "rgba(236, 72, 153, 0.35)",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                      }}
                                    >
                                      <FileText size={12} />
                                      Open PDF
                                    </button>
                                  ) : (
                                    <span style={{ color: "#ec4899", fontSize: 11.5, fontStyle: "italic", fontWeight: 500 }}>
                                      Rendering PDF…
                                    </span>
                                  )
                                )}
                              </div>
                              {isExpanded && (
                                <pre
                                  style={{
                                    marginTop: 10,
                                    padding: 14,
                                    background: "var(--bg)",
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
                            <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>
                              {status === "running"
                                ? (activeSiteInfo ? `Crawling (${activeSiteInfo.crawled}/${activeSiteInfo.maxPages || 10} p)` : "Queued...")
                                : "Ready"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {!result ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {activeSiteInfo ? (
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    padding: "2px 8px",
                                    borderRadius: 6,
                                    background: "rgba(59, 130, 246, 0.12)",
                                    color: "#3b82f6",
                                    border: "1px solid rgba(59, 130, 246, 0.25)",
                                  }}
                                >
                                  {isCancelling ? "Skipping..." : `${activeSiteInfo.percentage}%`}
                                </span>
                              ) : (
                                <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>Pending</span>
                              )}
                              {(status === "running" || status === "paused") && websiteVal && !isCancelling && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => handleSkipRow(idx, websiteVal)}
                                  title="Skip this website from audit"
                                  style={{
                                    padding: "2px 6px",
                                    fontSize: 11,
                                    height: 22,
                                    lineHeight: "18px",
                                    borderRadius: 4,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 3,
                                    color: "var(--red-text)",
                                    borderColor: "rgba(239, 68, 68, 0.25)",
                                    cursor: "pointer",
                                  }}
                                >
                                  <X size={10} />
                                  Skip
                                </button>
                              )}
                            </div>
                          ) : result.status === "success" ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 11.5,
                                fontWeight: 700,
                                padding: "2px 8px",
                                borderRadius: 6,
                                background: "rgba(16, 185, 129, 0.12)",
                                color: "#10b981",
                                border: "1px solid rgba(16, 185, 129, 0.3)",
                              }}
                            >
                              <CheckCircle2 size={12} /> Audited
                            </span>
                          ) : result.status === "skipped" ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 11.5,
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: 6,
                                background: "rgba(245, 158, 11, 0.12)",
                                color: "#f59e0b",
                                border: "1px solid rgba(245, 158, 11, 0.3)",
                              }}
                            >
                              Skipped
                            </span>
                          ) : (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 11.5,
                                fontWeight: 700,
                                padding: "2px 8px",
                                borderRadius: 6,
                                background: "rgba(239, 68, 68, 0.12)",
                                color: "#ef4444",
                                border: "1px solid rgba(239, 68, 68, 0.3)",
                              }}
                            >
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

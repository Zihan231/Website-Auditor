import { useCallback, useEffect, useState } from "react";
import type { CrawlConfig, CrawlResult } from "./lib/types";
import { cancelCrawl, openExternal, startCrawl, watchFullscreen } from "@platform/api";
import { Logo, IconBook, IconExternal, IconHistory, IconSettings, IconSearch, IconChevron } from "./components/ui";
import { StartView } from "./views/StartView";
import { CrawlingView, type Progress } from "./views/CrawlingView";
import { ResultsView } from "./views/ResultsView";
import { ReportsView } from "./views/ReportsView";
import { SettingsView } from "./views/SettingsView";
import { BulkAuditView } from "./views/BulkAuditView";
import { AccountControl } from "./components/AccountControl";
import { UpdateBanner } from "./components/UpdateBanner";
import { FileSpreadsheet } from "lucide-react";

type CrawlPhase =
  | { name: "idle" }
  | { name: "crawling"; config: CrawlConfig; progress: Progress }
  | { name: "done"; result: CrawlResult }
  | { name: "error"; message: string };

type NavTab = "crawl" | "reports" | "bulk" | "settings";

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>("crawl");
  const [crawlPhase, setCrawlPhase] = useState<CrawlPhase>({ name: "idle" });

  const start = useCallback(async (config: CrawlConfig) => {
    setCrawlPhase({ name: "crawling", config, progress: { crawled: 0, discovered: 0, queued: 0, current: config.url } });
    try {
      const result = await startCrawl(config, (e) => {
        if (e.type === "progress") {
          setCrawlPhase((p) =>
            p.name === "crawling"
              ? { ...p, progress: { crawled: e.crawled, discovered: e.discovered, queued: e.queued, current: e.current } }
              : p
          );
        }
      });
      setCrawlPhase({ name: "done", result });
    } catch (err) {
      setCrawlPhase({ name: "error", message: String(err) });
    }
  }, []);

  const reset = useCallback(() => {
    setCrawlPhase({ name: "idle" });
    setActiveTab("crawl");
  }, []);

  const handleCrawlTabClick = useCallback(() => {
    if (activeTab === "crawl" && (crawlPhase.name === "done" || crawlPhase.name === "error")) {
      setCrawlPhase({ name: "idle" });
    }
    setActiveTab("crawl");
  }, [activeTab, crawlPhase.name]);

  const cancel = useCallback(() => cancelCrawl(), []);

  const [collapsed, setCollapsed] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem("sidebar-collapsed") === "1"
  );
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* storage may be unavailable; ignore */
      }
      return next;
    });
  }, []);

  // Drop the sidebar's traffic-light spacing when the window is fullscreen.
  useEffect(() => {
    let un: (() => void) | undefined;
    watchFullscreen().then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

  const isFlush = (activeTab === "crawl" && crawlPhase.name === "done") || activeTab === "reports";

  return (
    <div className="app">
      <aside className={`sidebar${collapsed ? " collapsed" : ""}`} data-tauri-drag-region>
        <button className="sidebar-brand" onClick={() => setActiveTab("crawl")} aria-label="Home">
          <Logo />
        </button>
        <nav className="sidebar-nav">
          <button
            className={`nav-item${activeTab === "crawl" ? " active" : ""}`}
            onClick={handleCrawlTabClick}
            title="New crawl"
          >
            <IconSearch size={16} /> <span className="nav-label">New crawl</span>
          </button>
          <button
            className={`nav-item${activeTab === "reports" ? " active" : ""}`}
            onClick={() => setActiveTab("reports")}
            title="Reports"
          >
            <IconHistory size={16} /> <span className="nav-label">Reports</span>
          </button>
          <button
            className={`nav-item${activeTab === "bulk" ? " active" : ""}`}
            onClick={() => setActiveTab("bulk")}
            title="Bulk CSV Audit & Enrichment"
          >
            <FileSpreadsheet size={16} /> <span className="nav-label">Bulk Audit</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <a
            className="nav-item"
            href="https://crawlie.dev/docs"
            onClick={(e) => { e.preventDefault(); openExternal("https://crawlie.dev/docs"); }}
            title="Docs"
          >
            <IconBook size={16} /> <span className="nav-label">Docs</span>
          </a>
          <a
            className="nav-item"
            href="https://github.com/spronta/crawlie"
            onClick={(e) => { e.preventDefault(); openExternal("https://github.com/spronta/crawlie"); }}
            title="GitHub"
          >
            <IconExternal size={15} /> <span className="nav-label">GitHub</span>
          </a>
          <button
            className={`nav-item${activeTab === "settings" ? " active" : ""}`}
            onClick={() => setActiveTab("settings")}
            title="Settings"
          >
            <IconSettings size={16} /> <span className="nav-label">Settings</span>
          </button>
          <AccountControl />
          <div className="sidebar-foot-row">
            <button
              className="icon-btn collapse-toggle"
              onClick={toggleCollapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <IconChevron size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="content">
        <UpdateBanner />
        <main className={`main${isFlush ? " flush" : ""}`}>
          {/* Single Crawl View (preserved so switching tabs does not reset progress) */}
          <div style={{ display: activeTab === "crawl" ? "contents" : "none" }}>
            {crawlPhase.name === "idle" && <StartView onStart={start} />}
            {crawlPhase.name === "crawling" && <CrawlingView config={crawlPhase.config} progress={crawlPhase.progress} onCancel={cancel} />}
            {crawlPhase.name === "done" && <ResultsView result={crawlPhase.result} onReset={reset} onReports={() => setActiveTab("reports")} />}
            {crawlPhase.name === "error" && (
              <div className="hero">
                <h1 style={{ fontSize: 28 }}>Crawl failed</h1>
                <p className="mono" style={{ color: "var(--red-text)" }}>{crawlPhase.message}</p>
                <button className="btn btn-primary" onClick={reset}>Try again</button>
              </div>
            )}
          </div>

          {/* Reports View */}
          {activeTab === "reports" && (
            <ReportsView
              onBack={() => setActiveTab("crawl")}
              onOpen={(r) => {
                setCrawlPhase({ name: "done", result: r });
                setActiveTab("crawl");
              }}
            />
          )}

          {/* Bulk Audit View (preserved so switching tabs does not reset state, running audits or PDF generation) */}
          <div style={{ display: activeTab === "bulk" ? "contents" : "none" }}>
            <BulkAuditView onBack={() => setActiveTab("crawl")} />
          </div>

          {/* Settings View */}
          {activeTab === "settings" && <SettingsView onBack={() => setActiveTab("crawl")} />}
        </main>
      </div>
    </div>
  );
}

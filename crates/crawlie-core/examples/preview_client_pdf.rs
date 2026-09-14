//! Dev-only preview tool: crawl a URL and print the client-facing audit
//! report (`client_report::render`) straight to PDF, mirroring the exact
//! flow the bulk-audit PDF pipeline uses. Not part of the public API — for
//! reviewing report design changes before wiring them into the app.
//!
//! Usage: cargo run --example preview_client_pdf --features render -- <url> [max_pages] [out.pdf]

use crawlie_core::{crawl, render::Renderer, CancelToken, CrawlConfig};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = args.get(1).cloned().unwrap_or_else(|| "https://crawlie.dev".to_string());
    let max_pages: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20);
    let out = args.get(3).cloned().unwrap_or_else(|| "preview.pdf".to_string());

    eprintln!("Crawling {url} (max {max_pages} pages)...");
    let mut config = CrawlConfig::new(&url);
    config.max_pages = max_pages;

    let result = crawl(config, |_| {}, CancelToken::new())
        .await
        .expect("crawl failed");
    eprintln!(
        "Crawled {} pages, {} issues, health={} geo={} a11y={}",
        result.pages.len(),
        result.issues.len(),
        result.summary.health_score,
        result.summary.geo_score,
        result.summary.a11y_score,
    );

    let html = crawlie_core::client_report::render(&result);
    let html_path = std::env::temp_dir().join("crawlie-preview-report.html");
    std::fs::write(&html_path, &html).expect("write html");
    eprintln!("HTML written to {}", html_path.display());

    eprintln!("Launching headless browser to print PDF...");
    let renderer = Renderer::launch(None, 60).await.expect("launch renderer");
    let file_url = url::Url::from_file_path(&html_path).expect("file url");
    let bytes = renderer.pdf(&file_url).await.expect("print to pdf");
    std::fs::write(&out, bytes).expect("write pdf");
    eprintln!("PDF written to {out}");
}

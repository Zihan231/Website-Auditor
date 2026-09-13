//! Batch site auditing and email enrichment for bulk CSV/Excel processing.

use crate::crawler::{crawl, CancelToken};
use crate::knowledge::rule_info;
use crate::priority::top_fixes;
use crate::timefmt::format_utc;
use crate::types::{CrawlConfig, CrawlResult, Page, Severity};
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

static EMAIL_RE: OnceLock<Regex> = OnceLock::new();

fn get_email_regex() -> &'static Regex {
    EMAIL_RE.get_or_init(|| {
        Regex::new(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
            .expect("valid email regex")
    })
}

/// Check if an email string is a plausible real email address and not an asset or placeholder.
pub fn is_valid_email(email: &str) -> bool {
    let lower = email.trim().to_ascii_lowercase();
    if lower.len() < 5 || lower.len() > 100 {
        return false;
    }

    // Ignore file extensions that match the email regex pattern (e.g. image@2x.png)
    let bad_extensions = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
        ".css", ".js", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".pdf",
    ];
    for ext in bad_extensions {
        if lower.ends_with(ext) {
            return false;
        }
    }

    // Ignore dummy / placeholder / framework email addresses
    let bad_domains = [
        "example.com", "example.org", "domain.com", "yourdomain.com",
        "email.com", "test.com", "site.com", "sentry.io", "wixpress.com",
        "myshopify.com", "shopify.com", "gravatar.com",
    ];
    for d in bad_domains {
        if lower.ends_with(d) {
            return false;
        }
    }

    // Basic domain structure check: must have a dot after @ and no leading/trailing dot
    if let Some((local, domain)) = lower.split_once('@') {
        if local.is_empty() || domain.is_empty() {
            return false;
        }
        if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
            return false;
        }
    } else {
        return false;
    }

    true
}

/// Extract all valid emails from arbitrary text.
pub fn extract_emails_from_text(text: &str) -> Vec<String> {
    let re = get_email_regex();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for mat in re.find_iter(text) {
        let raw = mat.as_str().trim_matches(|c: char| !c.is_alphanumeric());
        let lower = raw.to_ascii_lowercase();
        if is_valid_email(&lower) && seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    out
}

/// Merge existing emails with newly discovered emails, deduplicating case-insensitively.
pub fn merge_emails(existing: Option<&str>, discovered: &[String]) -> String {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Some(s) = existing {
        for part in s.split([',', ';']) {
            let trimmed = part.trim();
            let lower = trimmed.to_ascii_lowercase();
            if is_valid_email(&lower) && seen.insert(lower) {
                out.push(trimmed.to_string());
            }
        }
    }

    for email in discovered {
        let lower = email.trim().to_ascii_lowercase();
        if is_valid_email(&lower) && seen.insert(lower.clone()) {
            out.push(lower);
        }
    }

    out.join(", ")
}

/// Normalize an input website string into a valid URL (defaulting to https://).
pub fn normalize_target_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        format!("https://{}", trimmed)
    } else {
        trimmed.to_string()
    };

    Url::parse(&with_scheme).ok().map(|u| u.to_string())
}

/// Outcome of auditing a single website.
#[derive(Debug, Clone)]
pub struct BatchAuditOutcome {
    pub success: bool,
    pub report: String,
    pub emails: Vec<String>,
}

/// Run a crawl on a website bounded by `max_pages` and format the audit report.
pub async fn audit_website_for_batch(
    target_url: &str,
    max_pages: usize,
    timeout_secs: u64,
    cancel: CancelToken,
) -> BatchAuditOutcome {
    let mut config = CrawlConfig::new(target_url);
    config.max_pages = max_pages.clamp(1, 1000);
    config.max_depth = 16;
    config.timeout_secs = timeout_secs.clamp(3, 30);
    config.concurrency = 12;
    config.check_external = true;
    config.use_sitemap = true;
    config.respect_robots = true;
    config.resolve_host = true;

    match crawl(config, |_| {}, cancel).await {
        Err(e) => {
            BatchAuditOutcome {
                success: false,
                report: format!("Error: {e}"),
                emails: Vec::new(),
            }
        }
        Ok(result) => {
            if result.pages.is_empty() {
                return BatchAuditOutcome {
                    success: false,
                    report: "Error: No reachable pages found".to_string(),
                    emails: Vec::new(),
                };
            }

            // Check root page status code
            let root_page = &result.pages[0];
            if root_page.status >= 400 {
                return BatchAuditOutcome {
                    success: false,
                    report: format!("Error: HTTP {}", root_page.status),
                    emails: Vec::new(),
                };
            }

            // Extract emails from all crawled pages
            let mut emails = Vec::new();
            let mut seen_emails = HashSet::new();

            for page in &result.pages {
                // Check body text
                if let Some(text) = &page.text {
                    for email in extract_emails_from_text(text) {
                        if seen_emails.insert(email.clone()) {
                            emails.push(email);
                        }
                    }
                }
                // Check search passages
                if let Some(st) = &page.search_text {
                    for email in extract_emails_from_text(st) {
                        if seen_emails.insert(email.clone()) {
                            emails.push(email);
                        }
                    }
                }
                // Check headings
                for h in &page.headings {
                    for email in extract_emails_from_text(h) {
                        if seen_emails.insert(email.clone()) {
                            emails.push(email);
                        }
                    }
                }
                // Check outgoing links for mailto:
                for link in &page.external_links {
                    if let Some(target) = link.strip_prefix("mailto:") {
                        let clean = target.split('?').next().unwrap_or(target).trim();
                        let lower = clean.to_ascii_lowercase();
                        if is_valid_email(&lower) && seen_emails.insert(lower.clone()) {
                            emails.push(lower);
                        }
                    }
                }
            }

            // Format comprehensive human and AI readable audit report
            let report = format_audit_report(&result, &emails);

            BatchAuditOutcome {
                success: true,
                report,
                emails,
            }
        }
    }
}

/// Format the complete detailed audit report string for spreadsheet insertion.
pub fn format_audit_report(result: &CrawlResult, emails: &[String]) -> String {
    let mut out = String::with_capacity(8192);

    let site_url = &result.config.url;
    let total_pages = result.summary.total_pages;

    // Date and duration formatting
    let crawl_date = if result.started_at > 0 {
        format_utc(result.started_at)
    } else {
        "Recent".to_string()
    };
    let dur_sec = result.summary.duration_ms as f64 / 1000.0;
    let dur_str = if dur_sec >= 1.0 {
        format!("{:.1}s", dur_sec)
    } else {
        format!("{}ms", result.summary.duration_ms)
    };

    let robots_status = if result.robots_found { "Found" } else { "Missing" };
    let sitemap_status = if result.sitemap_found || result.sitemap_urls > 0 {
        if result.sitemap_urls > 0 {
            format!("Found ({} URLs)", result.sitemap_urls)
        } else {
            "Found".to_string()
        }
    } else {
        "Missing".to_string()
    };
    let llms_status = if result.llms_txt_found { "Found" } else { "Missing" };

    // ==========================================
    // 1. OVERVIEW PAGE
    // ==========================================
    out.push_str("=== OVERVIEW PAGE ===\n");
    out.push_str(&format!("SITE: {site_url}\n"));
    if let Some(redirect) = &result.seed_redirected_from {
        out.push_str(&format!("↪ Seed {redirect} redirects to its canonical host — audited {site_url}\n"));
    }
    out.push_str(&format!("Crawled {crawl_date} · {total_pages} pages · {dur_str}\n"));
    out.push_str(&format!("Directives: robots.txt: {robots_status} · sitemap: {sitemap_status} · llms.txt: {llms_status}\n\n"));

    // TOP FIXES (Ranked by impact on your score)
    out.push_str("Top fixes (ranked by impact on your score):\n");
    let fixes = top_fixes(&result.issues, 5);
    if fixes.is_empty() {
        out.push_str("  No high-impact issues found 🎉\n\n");
    } else {
        for (idx, fix) in fixes.iter().enumerate() {
            let sev_str = match fix.severity {
                Severity::Error => "Error",
                Severity::Warning => "Warning",
                Severity::Notice => "Notice",
                Severity::Good => "Good",
            };
            out.push_str(&format!("{}\n{}\n{} · {}\n", idx + 1, sev_str, fix.title, fix.count));
            if !fix.how_to_fix.is_empty() {
                out.push_str(&format!("{}\n", fix.how_to_fix));
            }
            if !fix.why.is_empty() {
                out.push_str(&format!("Why it matters: {}\n", fix.why));
            }
            if let Some(info) = rule_info(&fix.rule) {
                if !info.impact.is_empty() {
                    out.push_str(&format!("If ignored: {}\n", info.impact));
                }
            }
            out.push('\n');
        }
    }

    // SCORES
    out.push_str("OVERALL SCORES:\n");
    out.push_str(&format!(
        "{} HEALTH - Technical SEO Health (Weighted across {total_pages} pages — errors, warnings and notices. Higher is healthier.)\n",
        result.summary.health_score
    ));
    out.push_str(&format!(
        "{} GEO - Generative Engine Readiness (How citable your pages are by AI search like ChatGPT, Perplexity, Google AI Overviews)\n",
        result.summary.geo_score
    ));
    out.push_str(&format!(
        "{} A11Y - Accessibility (WCAG conformance — accessible names, labels, zoom and heading order. Scored apart from SEO.)\n\n",
        result.summary.a11y_score
    ));

    // PAGES ROLLUP
    out.push_str("Pages crawled\n");
    out.push_str(&format!("{}\n", total_pages));
    out.push_str("Errors\n");
    out.push_str(&format!("{}\n", result.summary.errors));
    out.push_str("Warnings\n");
    out.push_str(&format!("{}\n", result.summary.warnings));
    out.push_str("Notices\n");
    out.push_str(&format!("{}\n", result.summary.notices));
    out.push_str("Indexable\n");
    let idx_pct = if total_pages > 0 {
        (result.summary.indexable_pages as f32 / total_pages as f32) * 100.0
    } else {
        0.0
    };
    out.push_str(&format!(
        "{:.0}% {}/{}\n",
        idx_pct, result.summary.indexable_pages, total_pages
    ));
    out.push_str("Duplicates\n");
    out.push_str(&format!("{}\n", result.summary.duplicate_pages));
    out.push_str("Avg response\n");
    out.push_str(&format!("{}ms\n\n", result.summary.avg_response_ms));

    // ISSUES BY SEVERITY
    out.push_str("Issues by severity\n");
    out.push_str(&format!("Errors: {}\n", result.summary.errors));
    out.push_str(&format!("Warnings: {}\n", result.summary.warnings));
    out.push_str(&format!("Notices: {}\n\n", result.summary.notices));

    // ISSUES BY CATEGORY (Sorted by count descending)
    out.push_str("Issues by category\n");
    let mut cat_list: Vec<(String, usize)> = result
        .summary
        .by_category
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    cat_list.sort_by(|a, b| b.1.cmp(&a.1));
    for (cat_name, count) in &cat_list {
        if *count > 0 {
            out.push_str(&format!("{} · {}\n", cat_name, count));
        }
    }
    out.push('\n');

    // STATUS CODES
    out.push_str("Status codes\n");
    let mut status_list: Vec<(u16, usize)> = result
        .summary
        .by_status
        .iter()
        .filter_map(|(k, v)| k.parse::<u16>().ok().map(|s| (s, *v)))
        .collect();
    status_list.sort_by_key(|a| a.0);
    for (code, count) in &status_list {
        out.push_str(&format!("{} · {}\n", code, count));
    }
    out.push('\n');

    // CRAWL DEPTH
    out.push_str("Crawl depth\n");
    let mut depth_list: Vec<(usize, usize)> = result
        .summary
        .by_depth
        .iter()
        .filter_map(|(k, v)| k.parse::<usize>().ok().map(|d| (d, *v)))
        .collect();
    depth_list.sort_by_key(|a| a.0);
    for (depth, count) in &depth_list {
        if *depth == 0 {
            out.push_str(&format!("Home · {}\n", count));
        } else if *depth == 1 {
            out.push_str(&format!("1 click · {}\n", count));
        } else {
            out.push_str(&format!("{} clicks · {}\n", depth, count));
        }
    }
    out.push('\n');

    // ==========================================
    // 2. ISSUES PAGE DEEP DIVE
    // ==========================================
    out.push_str("=== ISSUES PAGE ===\n");
    out.push_str(&format!("Issues {}\n\n", result.issues.len()));

    // 1. BROKEN LINKS DEEP DIVE
    let broken_issues_count = result.issues.iter().filter(|i| i.rule == "broken-link").count();
    if broken_issues_count > 0 || !result.broken_links.is_empty() {
        let bl_info = rule_info("broken-link");
        let pct = if total_pages > 0 {
            ((result.broken_links.len() as f32 / total_pages as f32) * 100.0).round() as usize
        } else {
            0
        };
        out.push_str(&format!(
            "Error\nBroken Link\n{}% of URLs\nLinks\n{}\n\n",
            pct, broken_issues_count
        ));
        if let Some(info) = &bl_info {
            out.push_str(&format!("Why it matters\n{}\n\n", info.why));
            out.push_str(&format!("How to fix\n{}\n\n", info.how_to_fix));
            out.push_str(&format!("If ignored\n{}\n\n", info.impact));
        }
        let unique_broken = result.broken_links.len();
        out.push_str(&format!(
            "{} unique broken URLs · {} occurrences\nStatus\tBroken URL\tUses\tPages\n",
            unique_broken, broken_issues_count
        ));
        let mut sorted_broken = result.broken_links.clone();
        sorted_broken.sort_by(|a, b| b.count.cmp(&a.count));
        for bl in sorted_broken.iter().take(35) {
            out.push_str(&format!(
                "{}\t{}\t{}\t{}\n",
                bl.status,
                bl.url,
                bl.count,
                bl.sources.len()
            ));
        }
        if sorted_broken.len() > 35 {
            out.push_str(&format!(
                "... and {} more unique broken URLs\n",
                sorted_broken.len() - 35
            ));
        }
        out.push('\n');
    }

    // 2. CLIENT ERRORS (4xx) & SERVER ERRORS (5xx)
    let error_pages: Vec<&Page> = result.pages.iter().filter(|p| p.status >= 400).collect();
    if !error_pages.is_empty() {
        let err_info = rule_info("client-error");
        let err_pct = if total_pages > 0 {
            ((error_pages.len() as f32 / total_pages as f32) * 100.0).round() as usize
        } else {
            0
        };
        out.push_str(&format!(
            "Error\nClient Error (4xx)\n{}% of URLs\nResponse Codes\n{}\n\n",
            err_pct, error_pages.len()
        ));
        if let Some(info) = &err_info {
            out.push_str(&format!("Why it matters\n{}\n\n", info.why));
            out.push_str(&format!("How to fix\n{}\n\n", info.how_to_fix));
            out.push_str(&format!("If ignored\n{}\n\n", info.impact));
        }
        out.push_str("Status\tError Page URL\n");
        for p in error_pages.iter().take(35) {
            out.push_str(&format!("{}\t{}\n", p.status, p.url));
        }
        if error_pages.len() > 35 {
            out.push_str(&format!(
                "... and {} more error pages\n",
                error_pages.len() - 35
            ));
        }
        out.push('\n');
    }

    // 3. BLOCKED BY ROBOTS.TXT
    let robots_issues_count = result
        .issues
        .iter()
        .filter(|i| i.rule == "robots-disallowed")
        .count();
    if robots_issues_count > 0 || !result.robots_blocked.is_empty() {
        let count = if robots_issues_count > 0 {
            robots_issues_count
        } else {
            result.robots_blocked.len()
        };
        let rob_info = rule_info("robots-disallowed");
        out.push_str(&format!(
            "Warning\nBlocked by robots.txt\nIndexability\n{}\n\n",
            count
        ));
        if let Some(info) = &rob_info {
            out.push_str(&format!("Why it matters\n{}\n\n", info.why));
            out.push_str(&format!("How to fix\n{}\n\n", info.how_to_fix));
            out.push_str(&format!("If ignored\n{}\n\n", info.impact));
        }
        if !result.robots_blocked.is_empty() {
            out.push_str("Sample Blocked URLs:\n");
            for u in result.robots_blocked.iter().take(10) {
                out.push_str(&format!("- {}\n", u));
            }
        }
        out.push('\n');
    }

    // 4. IMAGES MISSING ALT TEXT
    let missing_alt_count = result
        .issues
        .iter()
        .filter(|i| i.rule == "image-missing-alt")
        .count();
    if missing_alt_count > 0 {
        let alt_info = rule_info("image-missing-alt");
        out.push_str(&format!(
            "Warning\nImages Missing Alt Text\nImages\n{}\n\n",
            missing_alt_count
        ));
        if let Some(info) = &alt_info {
            out.push_str(&format!("Why it matters\n{}\n\n", info.why));
            out.push_str(&format!("How to fix\n{}\n\n", info.how_to_fix));
            out.push_str(&format!("If ignored\n{}\n\n", info.impact));
        }
        out.push('\n');
    }

    // 5. GEO: NO MACHINE-READABLE STRUCTURE
    let geo_no_struct = result
        .issues
        .iter()
        .filter(|i| i.rule == "geo-no-structure")
        .count();
    if geo_no_struct > 0 {
        let geo_info = rule_info("geo-no-structure");
        out.push_str(&format!(
            "Warning\nGEO: No Machine-Readable Structure\nGenerative Engine Optimization\n{}\n\n",
            geo_no_struct
        ));
        if let Some(info) = &geo_info {
            out.push_str(&format!("Why it matters\n{}\n\n", info.why));
            out.push_str(&format!("How to fix\n{}\n\n", info.how_to_fix));
            out.push_str(&format!("If ignored\n{}\n\n", info.impact));
        }
        out.push('\n');
    }

    // Schema Types Found
    let mut schema_set = HashSet::new();
    for p in &result.pages {
        for s in &p.schema_types {
            schema_set.insert(s.clone());
        }
    }
    if !schema_set.is_empty() {
        let mut types: Vec<_> = schema_set.into_iter().collect();
        types.sort();
        out.push_str(&format!("Structured Data Types Found: [{}]\n\n", types.join(", ")));
    }

    // ==========================================
    // 3. EMAILS DISCOVERED
    // ==========================================
    out.push_str("=== EMAILS DISCOVERED ===\n");
    if emails.is_empty() {
        out.push_str("None found\n");
    } else {
        out.push_str(&format!("{} unique email(s) found:\n", emails.len()));
        for email in emails {
            out.push_str(&format!("- {}\n", email));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_email_regex_and_validation() {
        assert!(is_valid_email("hello@fantasticsams.com"));
        assert!(is_valid_email("john.doe+support@gmail.com"));
        assert!(!is_valid_email("logo@2x.png"));
        assert!(!is_valid_email("icon@128x128.jpg"));
        assert!(!is_valid_email("test@example.com"));
        assert!(!is_valid_email("plainaddress"));
    }

    #[test]
    fn test_email_extraction() {
        let text = "Contact us at support@mycompany.org or sales@mycompany.org! Also check image@2x.png";
        let emails = extract_emails_from_text(text);
        assert_eq!(emails, vec!["support@mycompany.org", "sales@mycompany.org"]);
    }

    #[test]
    fn test_merge_emails() {
        let existing = "old@company.com, existing@company.com";
        let discovered = vec!["new@company.com".to_string(), "old@company.com".to_string()];
        let merged = merge_emails(Some(existing), &discovered);
        assert_eq!(merged, "old@company.com, existing@company.com, new@company.com");
    }

    #[test]
    fn test_detailed_format_audit_report() {
        use crate::types::{Category, CrawlConfig, CrawlResult, Issue, Page, Severity, Summary};
        use std::collections::BTreeMap;

        let mut root_page = Page::default();
        root_page.url = "https://www.example.com/".to_string();
        root_page.final_url = "https://www.example.com/".to_string();
        root_page.status = 200;
        root_page.hsts = true;
        root_page.server = Some("cloudflare".to_string());
        root_page.content_encoding = Some("br".to_string());
        root_page.word_count = 500;
        root_page.images_total = 10;
        root_page.geo.answerable = true;
        root_page.geo.semantic_html = true;
        root_page.geo.question_headings = 3;
        root_page.geo.structured_blocks = 5;

        let issue1 = Issue {
            rule: "image-missing-alt".to_string(),
            title: "Images Missing Alt Text".to_string(),
            category: Category::Images,
            severity: Severity::Warning,
            url: "https://www.example.com/".to_string(),
            detail: Some("logo.png".to_string()),
        };

        let issue2 = Issue {
            rule: "title-too-long".to_string(),
            title: "Title Too Long".to_string(),
            category: Category::TitlesMeta,
            severity: Severity::Warning,
            url: "https://www.example.com/about".to_string(),
            detail: Some("72 characters".to_string()),
        };

        let result = CrawlResult {
            config: CrawlConfig::new("https://www.example.com/"),
            pages: vec![root_page],
            issues: vec![issue1, issue2],
            broken_links: Vec::new(),
            summary: Summary {
                total_pages: 1,
                errors: 0,
                warnings: 2,
                notices: 0,
                good: 0,
                health_score: 85,
                geo_score: 75,
                a11y_score: 90,
                avg_response_ms: 150,
                indexable_pages: 1,
                duplicate_pages: 0,
                by_status: BTreeMap::new(),
                by_category: BTreeMap::new(),
                by_depth: BTreeMap::new(),
                duration_ms: 450,
            },
            robots_found: true,
            sitemap_urls: 5,
            sitemap_found: true,
            robots_blocked: Vec::new(),
            llms_txt_found: false,
            favicon: None,
            link_graph: Default::default(),
            seed_redirected_from: None,
            started_at: 1000,
            custom_rules: Vec::new(),
        };

        let emails = vec!["contact@example.com".to_string()];
        let report = format_audit_report(&result, &emails);

        assert!(report.contains("OVERVIEW PAGE"));
        assert!(report.contains("85 HEALTH"));
        assert!(report.contains("75 GEO"));
        assert!(report.contains("Top fixes"));
        assert!(report.contains("Images Missing Alt Text"));
        assert!(report.contains("Title Too Long"));
        assert!(report.contains("ISSUES PAGE"));
        assert!(report.contains("contact@example.com"));
    }
}

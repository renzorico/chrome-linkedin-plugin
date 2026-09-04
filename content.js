// LinkedIn Job Scraper - Content Script
// Uses click-based job ID collection + Voyager API for details.
// LinkedIn's new UI uses virtualized lists with role="button" cards.

const CSV_HEADERS = [
  "Title",
  "Description",
  "Company Name",
  "Location",
  "Detail URL",
  "Apply URL",
  "Created At",
];

const JOBS_PER_PAGE = 25;

// -- Utility --

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return match ? match[1] : null;
}

function sendProgress(progress) {
  try {
    chrome.runtime.sendMessage({ action: "progress", ...progress });
  } catch {
    // Popup may be closed
  }
}

// -- Job ID collection via clicking cards --

/**
 * Gets all job card containers from the lazy-column.
 */
function getJobCards() {
  const lazyCol = document.querySelector('[data-testid="lazy-column"]');
  if (!lazyCol) return [];
  return [...lazyCol.children].filter(
    (el) => el.tagName === "DIV" && el.textContent.trim().length > 10
  );
}

/**
 * Scrolls the job list to load all cards.
 */
async function scrollJobList() {
  const lazyCol = document.querySelector('[data-testid="lazy-column"]');
  const scrollTarget = lazyCol?.closest('[style*="overflow"]') || lazyCol?.parentElement;
  if (!scrollTarget) return;

  let prevCount = 0;
  let stable = 0;
  while (stable < 3) {
    scrollTarget.scrollTop = scrollTarget.scrollHeight;
    await sleep(800);
    const count = getJobCards().length;
    if (count === prevCount) stable++;
    else stable = 0;
    prevCount = count;
  }

  // Scroll back to top
  scrollTarget.scrollTop = 0;
  await sleep(300);
}

/**
 * Extracts the currentJobId from the page URL.
 */
function getCurrentJobId() {
  const url = new URL(window.location.href);
  return url.searchParams.get("currentJobId") || "";
}

/**
 * Clicks each job card to reveal its job ID in the URL.
 * Returns array of { jobId, title, companyName, location }.
 */
async function collectJobIds() {
  const cards = getJobCards();
  console.log(`[Scraper] Found ${cards.length} card containers`);

  const jobs = [];
  const seenIds = new Set();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];

    // Find the clickable element
    const button = card.querySelector('[role="button"]') || card;
    button.click();

    // Wait for URL to update
    await sleep(400);

    const jobId = getCurrentJobId();
    if (!jobId || seenIds.has(jobId)) continue;
    seenIds.add(jobId);

    // Extract info from card's individual DOM elements
    const parsed = parseCardElements(card);

    jobs.push({
      jobId,
      title: parsed.title,
      companyName: parsed.company,
      location: parsed.location,
      detailUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
      description: "",
      applyUrl: "",
      createdAt: "",
    });

    sendProgress({
      stage: "collecting",
      message: `Collecting job IDs: ${jobs.length}/${cards.length}`,
      current: i + 1,
      total: cards.length,
    });
  }

  return jobs;
}

/**
 * Extracts title, company, location from a card's DOM elements.
 * Each piece of info is in its own element, so we collect unique leaf texts.
 */
function parseCardElements(card) {
  // Metadata keywords to filter out
  const metaPattern = /^(Selected|Viewed|Posted|Easy Apply|Promoted|Actively recruiting|Reposted|\d+ (day|week|month|hour)s? ago|Be an early applicant|·)$/i;

  // Collect unique text from leaf-level elements
  const texts = [];
  const seen = new Set();
  const els = card.querySelectorAll("p, span");
  for (const el of els) {
    // Skip if this element has child elements with text (not a leaf)
    if (el.querySelector("p, span")) continue;
    const t = el.textContent.trim();
    if (!t || t.length < 2 || t.length > 120 || seen.has(t) || metaPattern.test(t)) continue;
    // Skip time-related strings
    if (/^\d+ (day|week|month|hour)s? ago/.test(t)) continue;
    seen.add(t);
    texts.push(t);
  }

  // Typical order: [title, company, location, ...other metadata]
  const title = texts[0] || "";
  const company = texts[1] || "";
  const location = texts[2] || "";

  return { title, company, location };
}

// -- Voyager API --

function buildVoyagerHeaders() {
  const csrfToken = getCsrfToken();
  if (!csrfToken) throw new Error("No CSRF token found. Are you logged in?");
  return {
    "csrf-token": csrfToken,
    accept: "application/vnd.linkedin.normalized+json+2.1",
  };
}

async function fetchJobDetail(jobId) {
  try {
    const headers = buildVoyagerHeaders();
    const response = await fetch(
      `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`,
      { headers, credentials: "include" }
    );

    if (!response.ok) {
      console.warn(`[Scraper] Detail fetch failed for ${jobId}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseJobDetail(data);
  } catch (err) {
    console.warn(`[Scraper] Detail fetch error for ${jobId}:`, err);
    return null;
  }
}

function parseJobDetail(data) {
  const detail = {};
  const jobData = data.data || data;

  if (jobData.description?.text) {
    detail.description = jobData.description.text;
  } else if (typeof jobData.description === "string") {
    detail.description = jobData.description;
  }

  if (jobData.title) detail.title = jobData.title;
  if (jobData.formattedLocation) detail.location = jobData.formattedLocation;

  // Company: store URN for separate resolution
  if (jobData.companyDetails?.company) {
    detail._companyUrn = jobData.companyDetails.company;
  }

  if (jobData.applyMethod) {
    const m = jobData.applyMethod;
    detail.applyUrl = m.companyApplyUrl ||
      (m["com.linkedin.voyager.jobs.OffsiteApply"] || m).companyApplyUrl || "";
  }

  if (jobData.listedAt) {
    detail.createdAt = new Date(jobData.listedAt).toISOString();
  } else if (jobData.originalListedAt) {
    detail.createdAt = new Date(jobData.originalListedAt).toISOString();
  }

  return detail;
}

/**
 * Resolves a company URN to a company name.
 * Caches results to avoid duplicate fetches.
 */
const companyCache = new Map();

async function resolveCompanyName(companyUrn) {
  if (!companyUrn) return "";
  if (companyCache.has(companyUrn)) return companyCache.get(companyUrn);

  const idMatch = companyUrn.match(/(\d+)$/);
  if (!idMatch) return "";

  try {
    const headers = buildVoyagerHeaders();
    const response = await fetch(
      `https://www.linkedin.com/voyager/api/organization/companies/${idMatch[1]}`,
      { headers, credentials: "include" }
    );
    if (response.ok) {
      const data = await response.json();
      const name = data.data?.name || data.name || "";
      companyCache.set(companyUrn, name);
      return name;
    }
  } catch {}

  companyCache.set(companyUrn, "");
  return "";
}

// -- CSV --

function jobToCsvRow(job) {
  return [
    job.title, job.description, job.companyName,
    job.location, job.detailUrl, job.applyUrl, job.createdAt,
  ].map(escapeCsvField).join(",");
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  if (/[,"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadCsv(csvContent, jobCount) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `linkedin-jobs-${jobCount}-${today}.csv`;

  // Send to background script to save via chrome.downloads API
  chrome.runtime.sendMessage(
    { action: "download", content: "\uFEFF" + csvContent, filename },
    (response) => {
      if (response?.success) {
        console.log(`[Scraper] Saved to linkedin-scraper/${filename}`);
      } else {
        console.warn("[Scraper] Download via background failed, using fallback");
        // Fallback: direct blob download
        const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    }
  );
}

// -- Pagination --

function getCurrentStart() {
  return parseInt(new URL(window.location.href).searchParams.get("start") || "0", 10);
}

function hasNextPage() {
  return !!document.querySelector(
    '[data-testid="pagination-controls-next-button-visible"]'
  );
}

function buildPageUrl(startOffset) {
  const url = new URL(window.location.href);
  url.searchParams.set("start", String(startOffset));
  return url.toString();
}

const STORAGE_KEY = "linkedin_scraper_state";

function saveState(state) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function clearState() {
  sessionStorage.removeItem(STORAGE_KEY);
}

// -- Main --

async function scrapeAllPages() {
  const state = loadState() || {
    jobs: [],
    seenIds: [],
    startOffset: getCurrentStart(),
    pageNumber: 1,
    phase: "collecting",
  };

  const seenIds = new Set(state.seenIds);

  sendProgress({
    stage: "scrolling",
    message: `Page ${state.pageNumber}: loading cards...`,
  });

  await scrollJobList();

  sendProgress({
    stage: "collecting",
    message: `Page ${state.pageNumber}: clicking cards to collect IDs...`,
  });

  const pageJobs = await collectJobIds();

  // Filter duplicates from previous pages
  const newJobs = pageJobs.filter((j) => !seenIds.has(j.jobId));
  for (const j of newJobs) seenIds.add(j.jobId);
  const allJobs = [...state.jobs, ...newJobs];

  console.log(
    `[Scraper] Page ${state.pageNumber}: ${newJobs.length} new jobs (${allJobs.length} total)`
  );

  // Check for next page
  if (newJobs.length > 0 && hasNextPage()) {
    const nextStart = state.startOffset + JOBS_PER_PAGE;

    saveState({
      jobs: allJobs,
      seenIds: [...seenIds],
      startOffset: nextStart,
      pageNumber: state.pageNumber + 1,
      phase: "collecting",
    });

    sendProgress({
      stage: "navigating",
      message: `Navigating to page ${state.pageNumber + 1}...`,
    });

    window.location.href = buildPageUrl(nextStart);
    return;
  }

  if (allJobs.length === 0) {
    clearState();
    sendProgress({
      stage: "error",
      message: "No jobs found. Check console for details.",
    });
    return;
  }

  // Fetch full details via API
  sendProgress({
    stage: "fetching",
    message: `Fetching details for ${allJobs.length} jobs...`,
    current: 0,
    total: allJobs.length,
  });

  for (let i = 0; i < allJobs.length; i++) {
    const detail = await fetchJobDetail(allJobs[i].jobId);
    if (detail) {
      if (detail.title) allJobs[i].title = detail.title;
      if (detail.location) allJobs[i].location = detail.location;
      allJobs[i].description = detail.description || "";
      allJobs[i].applyUrl = detail.applyUrl || "";
      allJobs[i].createdAt = detail.createdAt || "";

      // Always resolve company name from URN — card parsing is unreliable
      if (detail._companyUrn) {
        const name = await resolveCompanyName(detail._companyUrn);
        if (name) allJobs[i].companyName = name;
      }
    }

    sendProgress({
      stage: "fetching",
      message: `Fetching details: ${i + 1}/${allJobs.length}`,
      current: i + 1,
      total: allJobs.length,
    });

    if (i < allJobs.length - 1) await sleep(300 + Math.random() * 200);
  }

  const csv = [CSV_HEADERS.join(","), ...allJobs.map(jobToCsvRow)].join("\n");
  downloadCsv(csv, allJobs.length);
  clearState();

  sendProgress({
    stage: "done",
    message: `Done! Downloaded ${allJobs.length} jobs.`,
    total: allJobs.length,
  });
}

// Auto-resume after page navigation
(function autoResume() {
  const state = loadState();
  if (state?.phase === "collecting") {
    console.log(`[Scraper] Auto-resuming at page ${state.pageNumber}`);
    setTimeout(() => scrapeAllPages(), 2000);
  }
})();

// -- Message listener --

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrape") {
    clearState();
    scrapeAllPages()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error("[Scraper] Error:", err);
        clearState();
        sendProgress({ stage: "error", message: `Error: ${err.message}` });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

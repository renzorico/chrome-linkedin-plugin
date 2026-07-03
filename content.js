// LinkedIn Job Scraper - Content Script
// Runs on linkedin.com/jobs/* pages

const CSV_HEADERS = [
  "Title",
  "Description",
  "Primary Description",
  "Detail URL",
  "Apply URL",
  "Apply Type",
  "ATS Name",
  "Location",
  "Skill",
  "Insight",
  "Job State",
  "Poster Id",
  "Company Name",
  "Company Logo",
  "Created At",
  "Scraped At",
  "jobId",
  "companyUrn",
  "jobPostingUrn",
  "aboutLink",
];

const STORAGE_KEY = "linkedin_scraper_state";
const JOBS_PER_PAGE = 25;

/**
 * Extracts the job ID from a LinkedIn job card element.
 */
function getJobIdFromCard(card) {
  const dataId = card.getAttribute("data-job-id");
  if (dataId) return dataId.trim();

  const link = card.querySelector('a[href*="/jobs/view/"]');
  if (link) {
    const match = link.href.match(/\/jobs\/view\/(\d+)/);
    if (match) return match[1];
  }

  const occludable = card.getAttribute("data-occludable-job-id");
  if (occludable) return occludable.trim();

  return null;
}

/**
 * Scrapes basic info from a job card in the search results sidebar.
 */
function scrapeJobCard(card) {
  const jobId = getJobIdFromCard(card);
  if (!jobId) return null;

  const titleEl =
    card.querySelector(".job-card-list__title--link") ||
    card.querySelector("a.job-card-container__link") ||
    card.querySelector('a[href*="/jobs/view/"]');

  const title = titleEl
    ? (
        titleEl.querySelector("span") ||
        titleEl.querySelector("strong") ||
        titleEl
      ).textContent.trim()
    : "";

  const companyEl =
    card.querySelector(".artdeco-entity-lockup__subtitle") ||
    card.querySelector(".job-card-container__primary-description") ||
    card.querySelector(".job-card-container__company-name");
  const companyName = companyEl ? companyEl.textContent.trim() : "";

  const locationEl =
    card.querySelector(".artdeco-entity-lockup__caption") ||
    card.querySelector(".job-card-container__metadata-wrapper") ||
    card.querySelector(".job-card-container__metadata-item");
  const location = locationEl ? locationEl.textContent.trim() : "";

  const logoEl =
    card.querySelector("img.artdeco-entity-image") ||
    card.querySelector("img.ivm-view-attr__img--centered") ||
    card.querySelector('img[data-delayed-url]');
  const companyLogo = logoEl
    ? logoEl.src || logoEl.getAttribute("data-delayed-url") || ""
    : "";

  const detailUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

  return {
    jobId,
    title,
    companyName,
    location,
    companyLogo,
    detailUrl,
    description: "",
    primaryDescription: companyName,
    applyUrl: "",
    applyType: "",
    atsName: "",
    skill: "",
    insight: "",
    jobState: "",
    posterId: "",
    createdAt: "",
    companyUrn: "",
    jobPostingUrn: `urn:li:fsd_jobPosting:${jobId}`,
    aboutLink: "",
  };
}

/**
 * Scrolls the job list sidebar to ensure all cards on the current page are rendered.
 */
async function scrollCurrentPage() {
  const scrollContainer =
    document.querySelector(".jobs-search-results-list") ||
    document.querySelector(".scaffold-layout__list") ||
    document.querySelector('[class*="jobs-search-results"]');

  if (!scrollContainer) {
    console.warn("[Scraper] Could not find scroll container");
    return;
  }

  let previousCount = 0;
  let stableRounds = 0;

  while (stableRounds < 3) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(1000);

    const currentCount = getAllJobCards().length;
    if (currentCount === previousCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;
  }
}

/**
 * Returns all job card elements on the page.
 */
function getAllJobCards() {
  return document.querySelectorAll(
    '.job-card-container, .jobs-search-results__list-item, li.ember-view.occludable-update, [data-job-id], .scaffold-layout__list-item'
  );
}

/**
 * Fetches job detail using LinkedIn's internal Voyager API.
 */
async function fetchJobDetail(jobId) {
  try {
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      console.warn("[Scraper] No CSRF token found, skipping detail fetch");
      return null;
    }

    const response = await fetch(
      `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`,
      {
        headers: {
          "csrf-token": csrfToken,
          accept: "application/vnd.linkedin.normalized+json+2.1",
        },
        credentials: "include",
      }
    );

    if (!response.ok) {
      console.warn(`[Scraper] Detail fetch failed for ${jobId}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseJobDetail(data, jobId);
  } catch (err) {
    console.warn(`[Scraper] Detail fetch error for ${jobId}:`, err);
    return null;
  }
}

function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return match ? match[1] : null;
}

function parseJobDetail(data, jobId) {
  const detail = {};
  const jobData = data.data || data;
  const included = data.included || [];

  if (jobData.description && jobData.description.text) {
    detail.description = jobData.description.text;
  } else if (jobData.description && typeof jobData.description === "string") {
    detail.description = jobData.description;
  }

  if (jobData.applyMethod) {
    const applyMethod = jobData.applyMethod;
    if (applyMethod.companyApplyUrl) {
      detail.applyUrl = applyMethod.companyApplyUrl;
      detail.applyType = "External";
    } else if (
      applyMethod.easyApplyUrl ||
      applyMethod["com.linkedin.voyager.jobs.OffsiteApply"]
    ) {
      const offsite =
        applyMethod["com.linkedin.voyager.jobs.OffsiteApply"] || applyMethod;
      detail.applyUrl = offsite.companyApplyUrl || "";
      detail.applyType = "External";
    } else {
      detail.applyType = "LinkedIn";
    }
    detail.atsName = applyMethod.atsName || "";
  }

  if (jobData.companyDetails) {
    const companyRef =
      jobData.companyDetails[
        "com.linkedin.voyager.deco.jobs.web.shared.WebCompactJobPostingCompany"
      ];
    if (companyRef && companyRef.companyResolutionResult) {
      const company = companyRef.companyResolutionResult;
      detail.companyUrn = company.entityUrn || "";
      detail.aboutLink = company.url ? `${company.url}/about` : "";
    }
  }

  for (const entity of included) {
    if (
      entity.$type === "com.linkedin.voyager.organization.Company" ||
      entity.$type === "com.linkedin.voyager.entities.shared.MiniCompany"
    ) {
      if (!detail.companyUrn && entity.entityUrn) {
        detail.companyUrn = entity.entityUrn;
      }
      if (!detail.aboutLink && entity.url) {
        detail.aboutLink = `${entity.url}/about`;
      }
    }
  }

  detail.jobState = jobData.jobState || jobData.state || "LISTED";

  if (jobData.listedAt) {
    detail.createdAt = new Date(jobData.listedAt).toISOString();
  } else if (jobData.originalListedAt) {
    detail.createdAt = new Date(jobData.originalListedAt).toISOString();
  }

  if (jobData.skillMatchStatuses) {
    detail.skill = jobData.skillMatchStatuses
      .map((s) => s.skill?.name || s.localizedSkillDisplayName || "")
      .filter(Boolean)
      .join(", ");
  }

  if (jobData.posterProfileLink) {
    detail.posterId = jobData.posterProfileLink
      .replace(/.*\/in\//, "")
      .replace(/\/$/, "");
  }

  return detail;
}

function jobToCsvRow(job) {
  const scrapedAt = new Date().toISOString();
  const values = [
    job.title,
    job.description,
    job.primaryDescription,
    job.detailUrl,
    job.applyUrl,
    job.applyType,
    job.atsName,
    job.location,
    job.skill,
    job.insight,
    job.jobState,
    job.posterId,
    job.companyName,
    job.companyLogo,
    job.createdAt,
    scrapedAt,
    job.jobId,
    job.companyUrn,
    job.jobPostingUrn,
    job.aboutLink,
  ];
  return values.map(escapeCsvField).join(",");
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCsv(csvContent, jobCount) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `Job-Scraper-for-LinkedIn_jobs_${jobCount}_${today}.csv`;

  const bom = "\uFEFF";
  const blob = new Blob([bom + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pagination via URL ──────────────────────────────────────────────

/**
 * Gets the current `start` offset from the URL.
 */
function getCurrentStart() {
  const url = new URL(window.location.href);
  return parseInt(url.searchParams.get("start") || "0", 10);
}

/**
 * Builds the URL for a given start offset, preserving all other params.
 */
function buildPageUrl(startOffset) {
  const url = new URL(window.location.href);
  url.searchParams.set("start", String(startOffset));
  return url.toString();
}

/**
 * Saves scrape state to sessionStorage so it persists across page navigations.
 */
function saveState(state) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Loads scrape state from sessionStorage. Returns null if none exists.
 */
function loadState() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearState() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Scrapes all job cards from the current page view.
 */
function scrapeCurrentPageCards(seenIds) {
  const cards = getAllJobCards();
  const jobs = [];
  for (const card of cards) {
    const job = scrapeJobCard(card);
    if (job && !seenIds.has(job.jobId)) {
      seenIds.add(job.jobId);
      jobs.push(job);
    }
  }
  return jobs;
}

/**
 * Sends a progress message to the popup (best-effort, popup may be closed).
 */
function sendProgress(progress) {
  try {
    chrome.runtime.sendMessage({ action: "progress", ...progress });
  } catch {
    // Popup may be closed during multi-page scrape — that's fine
  }
}

/**
 * Main scraping function — handles one page at a time.
 * On the first call (from popup), it scrapes the current page and navigates to the next.
 * On subsequent calls (auto-resume after navigation), it continues from saved state.
 */
async function scrapeCurrentAndContinue(fullMode) {
  const state = loadState() || {
    mode: fullMode ? "full" : "fast",
    jobs: [],
    seenIds: [],
    startOffset: getCurrentStart(),
    pageNumber: 1,
    phase: "collecting", // "collecting" or "fetching"
  };

  const seenIds = new Set(state.seenIds);

  sendProgress({
    stage: "scrolling",
    message: `Page ${state.pageNumber} — scrolling to load cards...`,
  });

  // Scroll to render all cards on this page
  await scrollCurrentPage();

  // Scrape cards from this page
  const pageJobs = scrapeCurrentPageCards(seenIds);
  const allJobs = [...state.jobs, ...pageJobs];

  console.log(
    `[Scraper] Page ${state.pageNumber}: found ${pageJobs.length} new jobs (${allJobs.length} total)`
  );

  sendProgress({
    stage: "paging",
    message: `Page ${state.pageNumber} — ${allJobs.length} jobs collected so far`,
  });

  // If we got jobs on this page, there might be more pages
  if (pageJobs.length > 0) {
    const nextStart = state.startOffset + JOBS_PER_PAGE;

    // Save state and navigate to next page
    saveState({
      mode: state.mode,
      jobs: allJobs,
      seenIds: Array.from(seenIds),
      startOffset: nextStart,
      pageNumber: state.pageNumber + 1,
      phase: "collecting",
    });

    sendProgress({
      stage: "navigating",
      message: `Navigating to page ${state.pageNumber + 1}...`,
    });

    // Navigate — this reloads the page, content script re-injects and auto-resumes
    window.location.href = buildPageUrl(nextStart);
    return;
  }

  // No more jobs found — pagination complete. Now do detail fetching if full mode.
  sendProgress({
    stage: "parsed",
    message: `Collected ${allJobs.length} jobs across ${state.pageNumber} pages`,
    total: allJobs.length,
  });

  if (state.mode === "full" && allJobs.length > 0) {
    sendProgress({ stage: "fetching", message: "Fetching job details..." });

    for (let i = 0; i < allJobs.length; i++) {
      const detail = await fetchJobDetail(allJobs[i].jobId);
      if (detail) {
        Object.assign(allJobs[i], detail);
      }

      sendProgress({
        stage: "fetching",
        message: `Fetching details: ${i + 1}/${allJobs.length}`,
        current: i + 1,
        total: allJobs.length,
      });

      if (i < allJobs.length - 1) {
        await sleep(300 + Math.random() * 200);
      }
    }
  }

  // Build and download CSV
  const headerRow = CSV_HEADERS.join(",");
  const dataRows = allJobs.map(jobToCsvRow);
  const csv = [headerRow, ...dataRows].join("\n");

  downloadCsv(csv, allJobs.length);
  clearState();

  sendProgress({
    stage: "done",
    message: `Done! Downloaded ${allJobs.length} jobs.`,
    total: allJobs.length,
  });
}

// ── Auto-resume after page navigation ───────────────────────────────

(function autoResume() {
  const state = loadState();
  if (state && state.phase === "collecting") {
    console.log(
      `[Scraper] Auto-resuming scrape at page ${state.pageNumber} (start=${state.startOffset})`
    );
    // Small delay to let the page render
    setTimeout(() => {
      scrapeCurrentAndContinue(state.mode === "full");
    }, 2000);
  }
})();

// ── Message listener for popup ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrape") {
    const fullMode = message.mode === "full";

    // Clear any previous state and start fresh
    clearState();

    scrapeCurrentAndContinue(fullMode)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("[Scraper] Error:", err);
        clearState();
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }
});

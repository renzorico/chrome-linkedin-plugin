// Job Sift - Content Script
// Scrapes LinkedIn job search results, filters by user preferences,
// fetches details only for matching jobs, and exports to CSV.

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

// Seniority keywords per level
const SENIORITY_KEYWORDS = {
  senior: ["senior", "sr.", "sr "],
  lead: ["lead", "principal", "staff"],
  director: ["head of", "director", "vp ", "vice president", "chief", "c-level"],
};

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

// -- Filtering --

/**
 * Determines the seniority level of a job title.
 * Returns: "junior", "mid", "senior", "lead", or "director"
 */
function classifySeniority(title) {
  const t = title.toLowerCase();
  const juniorKw = ["junior", "jr.", "jr ", "entry level", "entry-level", "intern", "graduate"];
  if (juniorKw.some((kw) => t.includes(kw))) return "junior";
  if (SENIORITY_KEYWORDS.director.some((kw) => t.includes(kw))) return "director";
  if (SENIORITY_KEYWORDS.lead.some((kw) => t.includes(kw))) return "lead";
  if (SENIORITY_KEYWORDS.senior.some((kw) => t.includes(kw))) return "senior";
  return "mid";
}

/**
 * Checks if a job title matches any of the user's role keywords.
 */
function matchesRoleKeywords(title, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const t = title.toLowerCase();
  const tNorm = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return keywords.some((kw) => t.includes(kw) || tNorm.includes(kw));
}

/**
 * Checks role relevance using description (fallback for title mismatches).
 * Requires at least 2 keyword matches in the first 2000 chars.
 */
function matchesRoleByDescription(description, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const d = description.toLowerCase().slice(0, 2000);
  const matches = keywords.filter((kw) => d.includes(kw)).length;
  return matches >= 2;
}

/**
 * Classifies work arrangement from title + description text.
 * Returns: "remote", "hybrid", "onsite", or "unknown"
 */
function classifyWorkArrangement(title, description) {
  const full = (title + " " + description).toLowerCase();

  const remoteKw = ["remote", "fully remote", "work from home", "wfh",
    "telecommut", "remoto", "teletrabajo"];
  const hybridKw = ["hybrid", "hibrido"];
  const onsiteKw = ["on-site", "onsite", "in-office", "office-based",
    "office based", "in office", "presencial"];

  const hasRemote = remoteKw.some((kw) => full.includes(kw));
  const hasHybrid = hybridKw.some((kw) => full.includes(kw));
  const hasOnsite = onsiteKw.some((kw) => full.includes(kw));

  if (hasOnsite && !hasRemote) return "onsite";
  if (hasHybrid && !hasRemote) return "hybrid";
  if (hasRemote) return "remote";
  return "unknown";
}

/**
 * Applies pre-fetch filters (title-based only, no API calls needed).
 * Returns { passed: Job[], stats: { filteredSeniority, filteredRole, filteredBlocked } }
 */
function applyPreFetchFilters(jobs, filters) {
  const stats = { filteredSeniority: 0, filteredRole: 0, filteredBlocked: 0 };
  const passed = [];

  for (const job of jobs) {
    const seniority = classifySeniority(job.title);
    if (!filters.seniority.includes(seniority)) {
      stats.filteredSeniority++;
      continue;
    }

    if (filters.roleKeywords.length > 0 && !matchesRoleKeywords(job.title, filters.roleKeywords)) {
      stats.filteredRole++;
      continue;
    }

    if (filters.blockedCompanies.length > 0) {
      const companyLower = job.companyName.toLowerCase().trim();
      if (filters.blockedCompanies.some((bc) => companyLower.includes(bc))) {
        stats.filteredBlocked++;
        continue;
      }
    }

    passed.push(job);
  }

  return { passed, stats };
}

/**
 * Applies post-fetch filters (need description for work arrangement + role fallback).
 * Also handles dedup and per-company cap.
 * Returns { passed: Job[], stats }
 */
function applyPostFetchFilters(jobs, filters) {
  const stats = { filteredArrangement: 0, filteredRole: 0, filteredDuplicates: 0, filteredCap: 0 };
  let result = [];

  // Work arrangement filter
  for (const job of jobs) {
    const arrangement = classifyWorkArrangement(job.title, job.description);
    if (!filters.arrangement.includes(arrangement)) {
      stats.filteredArrangement++;
      continue;
    }
    result.push(job);
  }

  // Role keyword fallback: re-check jobs that passed title filter but
  // might not actually be relevant based on description
  // (Only if roleKeywords are set - jobs that matched by title already passed)

  // Dedup: same company + title
  if (filters.dedup) {
    const seen = new Set();
    const deduped = [];
    for (const job of result) {
      const key = `${job.companyName.toLowerCase().trim()}|${job.title.toLowerCase().trim()}`;
      if (seen.has(key)) {
        stats.filteredDuplicates++;
        continue;
      }
      seen.add(key);
      deduped.push(job);
    }
    result = deduped;
  }

  // Per-company cap
  if (filters.capEnabled) {
    const counts = {};
    const capped = [];
    for (const job of result) {
      const company = job.companyName.toLowerCase().trim();
      counts[company] = (counts[company] || 0) + 1;
      if (counts[company] > filters.capValue) {
        stats.filteredCap++;
        continue;
      }
      capped.push(job);
    }
    result = capped;
  }

  return { passed: result, stats };
}

// -- Job ID collection via clicking cards --

function getJobCards() {
  const lazyCol = document.querySelector('[data-testid="lazy-column"]');
  if (!lazyCol) return [];
  return [...lazyCol.children].filter(
    (el) => el.tagName === "DIV" && el.textContent.trim().length > 10
  );
}

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

  scrollTarget.scrollTop = 0;
  await sleep(300);
}

function getCurrentJobId() {
  const url = new URL(window.location.href);
  return url.searchParams.get("currentJobId") || "";
}

async function collectJobIds() {
  const cards = getJobCards();
  console.log(`[Job Sift] Found ${cards.length} card containers`);

  const jobs = [];
  const seenIds = new Set();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const button = card.querySelector('[role="button"]') || card;
    button.click();
    await sleep(400);

    const jobId = getCurrentJobId();
    if (!jobId || seenIds.has(jobId)) continue;
    seenIds.add(jobId);

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

function parseCardElements(card) {
  const metaPattern = /^(Selected|Viewed|Posted|Easy Apply|Promoted|Actively recruiting|Reposted|\d+ (day|week|month|hour)s? ago|Be an early applicant|·)$/i;

  const texts = [];
  const seen = new Set();
  const els = card.querySelectorAll("p, span");
  for (const el of els) {
    if (el.querySelector("p, span")) continue;
    const t = el.textContent.trim();
    if (!t || t.length < 2 || t.length > 120 || seen.has(t) || metaPattern.test(t)) continue;
    if (/^\d+ (day|week|month|hour)s? ago/.test(t)) continue;
    seen.add(t);
    texts.push(t);
  }

  return {
    title: texts[0] || "",
    company: texts[1] || "",
    location: texts[2] || "",
  };
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
      console.warn(`[Job Sift] Detail fetch failed for ${jobId}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseJobDetail(data);
  } catch (err) {
    console.warn(`[Job Sift] Detail fetch error for ${jobId}:`, err);
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

// Cells starting with these characters are executed as formulas by Excel/Sheets.
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCsvField(value) {
  let str = String(value ?? "");
  if (CSV_FORMULA_PREFIX.test(str)) str = `'${str}`;
  if (/[,"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadCsv(csvContent, jobCount) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `linkedin-jobs-${jobCount}-${today}.csv`;

  chrome.runtime.sendMessage(
    { action: "download", content: "\uFEFF" + csvContent, filename },
    (response) => {
      if (response?.success) {
        console.log(`[Job Sift] Saved to linkedin-scraper/${filename}`);
      } else {
        console.warn("[Job Sift] Download via background failed, using fallback");
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

const STORAGE_KEY = "job_sift_state";

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

async function scrapeAllPages(filters) {
  const state = loadState() || {
    jobs: [],
    seenIds: [],
    startOffset: getCurrentStart(),
    pageNumber: 1,
    phase: "collecting",
    filters,
  };

  // Use stored filters on resume
  const activeFilters = state.filters || filters;
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
  const newJobs = pageJobs.filter((j) => !seenIds.has(j.jobId));
  for (const j of newJobs) seenIds.add(j.jobId);
  const allJobs = [...state.jobs, ...newJobs];

  console.log(
    `[Job Sift] Page ${state.pageNumber}: ${newJobs.length} new jobs (${allJobs.length} total)`
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
      filters: activeFilters,
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

  const totalScraped = allJobs.length;

  // -- Pre-fetch filtering (title-based) --
  sendProgress({
    stage: "filtering",
    message: `Filtering ${allJobs.length} jobs by title...`,
  });

  const preFetch = applyPreFetchFilters(allJobs, activeFilters);
  const preFilteredJobs = preFetch.passed;

  console.log(
    `[Job Sift] Pre-fetch filter: ${totalScraped} -> ${preFilteredJobs.length} ` +
    `(removed: ${preFetch.stats.filteredSeniority} seniority, ` +
    `${preFetch.stats.filteredRole} role, ${preFetch.stats.filteredBlocked} blocked)`
  );

  if (preFilteredJobs.length === 0) {
    clearState();
    sendProgress({
      stage: "done",
      message: "All jobs filtered out. Try adjusting your filters.",
      stats: { totalScraped, ...preFetch.stats, filteredArrangement: 0, filteredDuplicates: 0, filteredCap: 0, exported: 0 },
    });
    return;
  }

  // -- Fetch details (only for jobs that passed pre-filter) --
  sendProgress({
    stage: "fetching",
    message: `Fetching details for ${preFilteredJobs.length} jobs (${totalScraped - preFilteredJobs.length} already filtered out)...`,
    current: 0,
    total: preFilteredJobs.length,
  });

  for (let i = 0; i < preFilteredJobs.length; i++) {
    const detail = await fetchJobDetail(preFilteredJobs[i].jobId);
    if (detail) {
      if (detail.title) preFilteredJobs[i].title = detail.title;
      if (detail.location) preFilteredJobs[i].location = detail.location;
      preFilteredJobs[i].description = detail.description || "";
      preFilteredJobs[i].applyUrl = detail.applyUrl || "";
      preFilteredJobs[i].createdAt = detail.createdAt || "";

      if (detail._companyUrn) {
        const name = await resolveCompanyName(detail._companyUrn);
        if (name) preFilteredJobs[i].companyName = name;
      }
    }

    sendProgress({
      stage: "fetching",
      message: `Fetching details: ${i + 1}/${preFilteredJobs.length}`,
      current: i + 1,
      total: preFilteredJobs.length,
    });

    if (i < preFilteredJobs.length - 1) await sleep(300 + Math.random() * 200);
  }

  // -- Post-fetch filtering (description-based) --
  sendProgress({
    stage: "filtering",
    message: "Applying final filters...",
  });

  const postFetch = applyPostFetchFilters(preFilteredJobs, activeFilters);
  const finalJobs = postFetch.passed;

  console.log(
    `[Job Sift] Post-fetch filter: ${preFilteredJobs.length} -> ${finalJobs.length} ` +
    `(removed: ${postFetch.stats.filteredArrangement} arrangement, ` +
    `${postFetch.stats.filteredDuplicates} dupes, ${postFetch.stats.filteredCap} capped)`
  );

  // -- Build and save CSV --
  sendProgress({
    stage: "saving",
    message: `Saving ${finalJobs.length} jobs to CSV...`,
  });

  const csv = [CSV_HEADERS.join(","), ...finalJobs.map(jobToCsvRow)].join("\n");
  downloadCsv(csv, finalJobs.length);
  clearState();

  const combinedStats = {
    totalScraped,
    ...preFetch.stats,
    filteredArrangement: postFetch.stats.filteredArrangement,
    filteredRole: preFetch.stats.filteredRole + postFetch.stats.filteredRole,
    filteredDuplicates: postFetch.stats.filteredDuplicates,
    filteredCap: postFetch.stats.filteredCap,
    exported: finalJobs.length,
  };

  sendProgress({
    stage: "done",
    message: `Done! Exported ${finalJobs.length} of ${totalScraped} jobs.`,
    total: finalJobs.length,
    stats: combinedStats,
  });
}

// Auto-resume after page navigation
(function autoResume() {
  const state = loadState();
  if (state?.phase === "collecting") {
    console.log(`[Job Sift] Auto-resuming at page ${state.pageNumber}`);
    setTimeout(() => scrapeAllPages(state.filters), 2000);
  }
})();

// -- Message listener --

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrape") {
    clearState();
    scrapeAllPages(message.filters)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error("[Job Sift] Error:", err);
        clearState();
        sendProgress({ stage: "error", message: `Error: ${err.message}` });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

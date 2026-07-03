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

/**
 * Extracts the job ID from a LinkedIn job card element.
 */
function getJobIdFromCard(card) {
  // data-job-id attribute
  const dataId = card.getAttribute("data-job-id");
  if (dataId) return dataId.trim();

  // From the detail link href: /jobs/view/1234567890/
  const link = card.querySelector('a[href*="/jobs/view/"]');
  if (link) {
    const match = link.href.match(/\/jobs\/view\/(\d+)/);
    if (match) return match[1];
  }

  // data-occludable-job-id
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

  const logoEl = card.querySelector("img.artdeco-entity-image") ||
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
    // Fields populated by detail fetch
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
 * Auto-scrolls the job list sidebar to load all job cards.
 */
async function autoScrollJobList() {
  const scrollContainer =
    document.querySelector(".jobs-search-results-list") ||
    document.querySelector(".scaffold-layout__list") ||
    document.querySelector('[class*="jobs-search-results"]');

  if (!scrollContainer) {
    console.warn("[Scraper] Could not find scroll container, using window");
    return;
  }

  let previousCount = 0;
  let stableRounds = 0;
  const MAX_STABLE_ROUNDS = 3;

  while (stableRounds < MAX_STABLE_ROUNDS) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(1500);

    const currentCount = getAllJobCards().length;
    if (currentCount === previousCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;

    // Click "See more jobs" button if present
    const seeMoreBtn =
      document.querySelector("button.infinite-scroller__show-more-button") ||
      document.querySelector('button[aria-label="See more jobs"]');
    if (seeMoreBtn) {
      seeMoreBtn.click();
      await sleep(2000);
    }
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
 * Uses the same session cookies as the browser.
 */
async function fetchJobDetail(jobId) {
  try {
    // Get CSRF token from cookie
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

/**
 * Extracts the CSRF token from LinkedIn cookies.
 */
function getCsrfToken() {
  const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return match ? match[1] : null;
}

/**
 * Parses the Voyager API response into our job fields.
 */
function parseJobDetail(data, jobId) {
  const detail = {};

  // The response structure can vary, handle both normalized and flat formats
  const jobData = data.data || data;
  const included = data.included || [];

  // Description - HTML stripped to text
  if (jobData.description && jobData.description.text) {
    detail.description = jobData.description.text;
  } else if (jobData.description && typeof jobData.description === "string") {
    detail.description = jobData.description;
  }

  // Apply URL and type
  if (jobData.applyMethod) {
    const applyMethod = jobData.applyMethod;
    if (applyMethod.companyApplyUrl) {
      detail.applyUrl = applyMethod.companyApplyUrl;
      detail.applyType = "External";
    } else if (applyMethod.easyApplyUrl || applyMethod["com.linkedin.voyager.jobs.OffsiteApply"]) {
      const offsite = applyMethod["com.linkedin.voyager.jobs.OffsiteApply"] || applyMethod;
      detail.applyUrl = offsite.companyApplyUrl || "";
      detail.applyType = "External";
    } else {
      detail.applyType = "LinkedIn";
    }
    detail.atsName = applyMethod.atsName || "";
  }

  // Company URN
  if (jobData.companyDetails) {
    const companyRef = jobData.companyDetails["com.linkedin.voyager.deco.jobs.web.shared.WebCompactJobPostingCompany"];
    if (companyRef && companyRef.companyResolutionResult) {
      const company = companyRef.companyResolutionResult;
      detail.companyUrn = company.entityUrn || "";
      detail.aboutLink = company.url ? `${company.url}/about` : "";
    }
  }

  // Try included entities for company info
  for (const entity of included) {
    if (entity.$type === "com.linkedin.voyager.organization.Company" ||
        entity.$type === "com.linkedin.voyager.entities.shared.MiniCompany") {
      if (!detail.companyUrn && entity.entityUrn) {
        detail.companyUrn = entity.entityUrn;
      }
      if (!detail.aboutLink && entity.url) {
        detail.aboutLink = `${entity.url}/about`;
      }
    }
  }

  // Job state
  detail.jobState = jobData.jobState || jobData.state || "LISTED";

  // Created at
  if (jobData.listedAt) {
    detail.createdAt = new Date(jobData.listedAt).toISOString();
  } else if (jobData.originalListedAt) {
    detail.createdAt = new Date(jobData.originalListedAt).toISOString();
  }

  // Skills
  if (jobData.skillMatchStatuses) {
    detail.skill = jobData.skillMatchStatuses
      .map((s) => s.skill?.name || s.localizedSkillDisplayName || "")
      .filter(Boolean)
      .join(", ");
  }

  // Poster
  if (jobData.posterProfileLink) {
    detail.posterId = jobData.posterProfileLink.replace(/.*\/in\//, "").replace(/\/$/, "");
  }

  return detail;
}

/**
 * Converts a job object to a CSV row matching the Lemon Squeezy format.
 */
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

/**
 * Escapes a field for CSV output.
 */
function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Downloads a CSV string as a file.
 */
function downloadCsv(csvContent, jobCount) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `Job-Scraper-for-LinkedIn_jobs_${jobCount}_${today}.csv`;

  // Add BOM for Excel compatibility (matches Lemon Squeezy output)
  const bom = "\uFEFF";
  const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
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

/**
 * Main scraping function. Called from popup via message passing.
 * @param {boolean} fullMode - If true, fetches individual job details.
 * @param {function} onProgress - Callback for progress updates.
 */
async function scrapeJobs(fullMode, onProgress) {
  onProgress({ stage: "scrolling", message: "Scrolling to load all jobs..." });

  await autoScrollJobList();

  const cards = getAllJobCards();
  onProgress({ stage: "parsing", message: `Found ${cards.length} job cards` });

  const jobs = [];
  const seenIds = new Set();

  for (const card of cards) {
    const job = scrapeJobCard(card);
    if (job && !seenIds.has(job.jobId)) {
      seenIds.add(job.jobId);
      jobs.push(job);
    }
  }

  onProgress({
    stage: "parsed",
    message: `Parsed ${jobs.length} unique jobs`,
    total: jobs.length,
  });

  if (fullMode && jobs.length > 0) {
    onProgress({ stage: "fetching", message: "Fetching job details..." });

    for (let i = 0; i < jobs.length; i++) {
      const detail = await fetchJobDetail(jobs[i].jobId);
      if (detail) {
        Object.assign(jobs[i], detail);
      }

      onProgress({
        stage: "fetching",
        message: `Fetching details: ${i + 1}/${jobs.length}`,
        current: i + 1,
        total: jobs.length,
      });

      // Rate limiting — don't hammer the API
      if (i < jobs.length - 1) {
        await sleep(300 + Math.random() * 200);
      }
    }
  }

  // Build CSV
  const headerRow = CSV_HEADERS.join(",");
  const dataRows = jobs.map(jobToCsvRow);
  const csv = [headerRow, ...dataRows].join("\n");

  downloadCsv(csv, jobs.length);

  onProgress({
    stage: "done",
    message: `Done! Downloaded ${jobs.length} jobs.`,
    total: jobs.length,
  });

  return jobs.length;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "scrape") {
    const fullMode = message.mode === "full";

    scrapeJobs(fullMode, (progress) => {
      // Send progress updates back to popup
      chrome.runtime.sendMessage({ action: "progress", ...progress });
    })
      .then((count) => {
        sendResponse({ success: true, count });
      })
      .catch((err) => {
        console.error("[Scraper] Error:", err);
        sendResponse({ success: false, error: err.message });
      });

    // Keep the message channel open for async response
    return true;
  }
});

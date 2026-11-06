const scrapeBtn = document.getElementById("scrapeBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const filterStats = document.getElementById("filterStats");

// -- Default filter config --

const DEFAULT_FILTERS = {
  seniority: ["junior", "mid"],
  arrangement: ["remote", "unknown"],
  roleKeywords: [
    "data sci", "data analy", "analytics", "machine learn",
    "ml ", "ml/", "ai ", "ai/", "deep learn", "nlp",
    "business intel", "bi ", "statistician", "data engineer",
    "research scien", "quantitative", "computer vision",
    "artificial intelligence", "applied scien",
  ],
  blockedCompanies: [
    "jobgether", "hire feed", "hired", "crossover", "turing",
    "toptal", "andela", "talent.com", "jobot",
  ],
  dedup: true,
  capEnabled: true,
  capValue: 5,
};

// -- Tab switching --

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// -- Tag input helper --

function setupTagInput(containerId, inputId, initialTags, onChange) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  let tags = [...initialTags];

  function render() {
    container.querySelectorAll(".tag").forEach((t) => t.remove());
    tags.forEach((tag, i) => {
      const el = document.createElement("span");
      el.className = "tag";
      el.innerHTML = `${escapeHtml(tag)}<span class="remove" data-index="${i}">x</span>`;
      container.insertBefore(el, input);
    });
  }

  container.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove")) {
      tags.splice(parseInt(e.target.dataset.index), 1);
      render();
      onChange(tags);
    } else {
      input.focus();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().toLowerCase();
      if (!tags.includes(val)) {
        tags.push(val);
        render();
        onChange(tags);
      }
      input.value = "";
    }
    if (e.key === "Backspace" && !input.value && tags.length > 0) {
      tags.pop();
      render();
      onChange(tags);
    }
  });

  render();

  return {
    setTags(newTags) {
      tags = [...newTags];
      render();
    },
    getTags() { return [...tags]; },
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// -- Load / save settings --

let currentFilters = { ...DEFAULT_FILTERS };
let roleTagInput;
let blockedTagInput;

async function loadFilters() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("filters", (result) => {
      if (result.filters) {
        currentFilters = { ...DEFAULT_FILTERS, ...result.filters };
      }
      resolve();
    });
  });
}

function saveFilters() {
  chrome.storage.sync.set({ filters: currentFilters });
}

function applyFiltersToUI() {
  // Seniority checkboxes
  document.querySelectorAll("#seniorityGroup input").forEach((cb) => {
    cb.checked = currentFilters.seniority.includes(cb.value);
  });

  // Arrangement checkboxes
  document.querySelectorAll("#arrangementGroup input").forEach((cb) => {
    cb.checked = currentFilters.arrangement.includes(cb.value);
  });

  // Dedup
  document.getElementById("dedupToggle").checked = currentFilters.dedup;

  // Cap
  document.getElementById("capToggle").checked = currentFilters.capEnabled;
  document.getElementById("capValue").value = currentFilters.capValue;

  // Tags
  if (roleTagInput) roleTagInput.setTags(currentFilters.roleKeywords);
  if (blockedTagInput) blockedTagInput.setTags(currentFilters.blockedCompanies);
}

function bindFilterListeners() {
  // Seniority
  document.querySelectorAll("#seniorityGroup input").forEach((cb) => {
    cb.addEventListener("change", () => {
      currentFilters.seniority = [...document.querySelectorAll("#seniorityGroup input:checked")]
        .map((c) => c.value);
      saveFilters();
    });
  });

  // Arrangement
  document.querySelectorAll("#arrangementGroup input").forEach((cb) => {
    cb.addEventListener("change", () => {
      currentFilters.arrangement = [...document.querySelectorAll("#arrangementGroup input:checked")]
        .map((c) => c.value);
      saveFilters();
    });
  });

  // Dedup
  document.getElementById("dedupToggle").addEventListener("change", (e) => {
    currentFilters.dedup = e.target.checked;
    saveFilters();
  });

  // Cap
  document.getElementById("capToggle").addEventListener("change", (e) => {
    currentFilters.capEnabled = e.target.checked;
    saveFilters();
  });
  document.getElementById("capValue").addEventListener("change", (e) => {
    currentFilters.capValue = Math.max(1, parseInt(e.target.value) || 5);
    saveFilters();
  });

  // Reset
  document.getElementById("resetBtn").addEventListener("click", () => {
    currentFilters = { ...DEFAULT_FILTERS };
    applyFiltersToUI();
    saveFilters();
  });
}

// -- Progress listener --

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress") {
    statusEl.textContent = message.message;
    statusEl.className = "";

    if (message.total && message.current) {
      progressBar.style.display = "block";
      const pct = Math.round((message.current / message.total) * 100);
      progressFill.style.width = `${pct}%`;
    }

    if (message.stage === "done") {
      statusEl.className = "success";
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = "Sift Jobs";
      setTimeout(() => { progressBar.style.display = "none"; }, 2000);

      // Show filter stats if available
      if (message.stats) {
        showFilterStats(message.stats);
      }
    }

    if (message.stage === "error") {
      statusEl.className = "error";
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = "Sift Jobs";
      progressBar.style.display = "none";
      filterStats.style.display = "none";
    }
  }
});

function showFilterStats(stats) {
  const rows = [];
  if (stats.totalScraped > 0) {
    rows.push(["Scraped from pages", stats.totalScraped]);
  }
  if (stats.filteredSeniority > 0) {
    rows.push(["Removed (seniority)", `-${stats.filteredSeniority}`]);
  }
  if (stats.filteredRole > 0) {
    rows.push(["Removed (role mismatch)", `-${stats.filteredRole}`]);
  }
  if (stats.filteredBlocked > 0) {
    rows.push(["Removed (blocked company)", `-${stats.filteredBlocked}`]);
  }
  if (stats.filteredArrangement > 0) {
    rows.push(["Removed (work arrangement)", `-${stats.filteredArrangement}`]);
  }
  if (stats.filteredDuplicates > 0) {
    rows.push(["Removed (duplicates)", `-${stats.filteredDuplicates}`]);
  }
  if (stats.filteredCap > 0) {
    rows.push(["Removed (company cap)", `-${stats.filteredCap}`]);
  }

  let html = rows.map(([label, value]) =>
    `<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`
  ).join("");

  html += `<div class="stat-row stat-total"><span>Exported</span><span>${stats.exported}</span></div>`;

  filterStats.innerHTML = html;
  filterStats.style.display = "block";
}

// -- Scrape button --

scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  scrapeBtn.textContent = "Sifting...";
  statusEl.textContent = "Starting...";
  statusEl.className = "";
  progressBar.style.display = "none";
  progressFill.style.width = "0%";
  filterStats.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes("linkedin.com/jobs")) {
      statusEl.textContent = "Navigate to a LinkedIn Jobs search page first.";
      statusEl.className = "error";
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = "Sift Jobs";
      return;
    }

    // Send filters along with scrape command
    chrome.tabs.sendMessage(
      tab.id,
      { action: "scrape", filters: currentFilters },
      (response) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent = "Could not connect. Try refreshing the LinkedIn page.";
          statusEl.className = "error";
          scrapeBtn.disabled = false;
          scrapeBtn.textContent = "Sift Jobs";
          return;
        }
        if (response && !response.success) {
          statusEl.textContent = `Error: ${response.error}`;
          statusEl.className = "error";
          scrapeBtn.disabled = false;
          scrapeBtn.textContent = "Sift Jobs";
        }
      }
    );
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = "error";
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = "Sift Jobs";
  }
});

// -- Init --

(async () => {
  await loadFilters();

  roleTagInput = setupTagInput("roleKeywordsContainer", "roleKeywordsInput",
    currentFilters.roleKeywords, (tags) => {
      currentFilters.roleKeywords = tags;
      saveFilters();
    });

  blockedTagInput = setupTagInput("blockedCompaniesContainer", "blockedCompaniesInput",
    currentFilters.blockedCompanies, (tags) => {
      currentFilters.blockedCompanies = tags;
      saveFilters();
    });

  applyFiltersToUI();
  bindFilterListeners();
})();

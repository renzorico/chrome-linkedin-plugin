const scrapeBtn = document.getElementById("scrapeBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const modeHint = document.getElementById("modeHint");
const modeFast = document.getElementById("modeFast");
const modeFull = document.getElementById("modeFull");

const MODE_HINTS = {
  fast: "Card-level data only. No descriptions or apply URLs.",
  full: "Fetches full details for each job. Slower but complete.",
};

function getSelectedMode() {
  return modeFull.checked ? "full" : "fast";
}

modeFast.addEventListener("change", () => {
  modeHint.textContent = MODE_HINTS.fast;
});
modeFull.addEventListener("change", () => {
  modeHint.textContent = MODE_HINTS.full;
});

// Listen for progress updates from content script
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
      scrapeBtn.textContent = "Scrape Jobs";
      setTimeout(() => {
        progressBar.style.display = "none";
      }, 2000);
    }
  }
});

scrapeBtn.addEventListener("click", async () => {
  const mode = getSelectedMode();

  scrapeBtn.disabled = true;
  scrapeBtn.textContent = "Scraping...";
  statusEl.textContent = "Starting...";
  statusEl.className = "";
  progressBar.style.display = "none";
  progressFill.style.width = "0%";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.url?.includes("linkedin.com/jobs")) {
      statusEl.textContent = "Navigate to a LinkedIn Jobs search page first.";
      statusEl.className = "error";
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = "Scrape Jobs";
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      { action: "scrape", mode },
      (response) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent =
            "Error: Could not connect. Try refreshing the LinkedIn page.";
          statusEl.className = "error";
          scrapeBtn.disabled = false;
          scrapeBtn.textContent = "Scrape Jobs";
          return;
        }

        if (response && !response.success) {
          statusEl.textContent = `Error: ${response.error}`;
          statusEl.className = "error";
          scrapeBtn.disabled = false;
          scrapeBtn.textContent = "Scrape Jobs";
        }
      }
    );
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = "error";
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = "Scrape Jobs";
  }
});

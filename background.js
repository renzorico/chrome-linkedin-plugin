// Background service worker - handles downloads to specific folder

const SAFE_FILENAME = /^linkedin-jobs-\d+-\d{4}-\d{2}-\d{2}\.csv$/;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === "download") {
    if (!SAFE_FILENAME.test(message.filename)) {
      sendResponse({ success: false, error: "Invalid filename" });
      return;
    }
    const blob = new Blob([message.content], { type: "text/csv;charset=utf-8;" });
    const reader = new FileReader();
    reader.onload = () => {
      chrome.downloads.download(
        {
          url: reader.result,
          filename: `linkedin-scraper/${message.filename}`,
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error("[Scraper] Download error:", chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, downloadId });
          }
        }
      );
    };
    reader.readAsDataURL(blob);
    return true;
  }
});

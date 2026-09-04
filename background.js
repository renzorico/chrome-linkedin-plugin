// Background service worker - handles downloads to specific folder

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "download") {
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

# LinkedIn Job Scraper - Chrome Extension

Chrome extension that scrapes LinkedIn job search results and exports them to CSV.

## Setup

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select this directory
4. Navigate to a LinkedIn Jobs search page
5. Click the extension icon and hit **Scrape Jobs**

## Modes

- **Fast** - scrapes card-level data only (title, company, location, URL). Instant.
- **Full** - fetches full details for each job (description, apply URL, skills, etc.). Slower but produces complete output matching the Lemon Squeezy CSV format.

## Output

Downloads a CSV file named `Job-Scraper-for-LinkedIn_jobs_{count}_{date}.csv` with the following columns:

Title, Description, Primary Description, Detail URL, Apply URL, Apply Type, ATS Name, Location, Skill, Insight, Job State, Poster Id, Company Name, Company Logo, Created At, Scraped At, jobId, companyUrn, jobPostingUrn, aboutLink

## Requirements

- Google Chrome (or Chromium-based browser)
- Active LinkedIn session (you must be logged in)

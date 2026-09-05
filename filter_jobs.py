"""
Filters scraped LinkedIn jobs CSV for career-ops agents.
Creates a filtered copy — never modifies the original.

Filters:
  1. Seniority: remove senior, lead, principal, staff, head, director
  2. Work arrangement: remove explicitly onsite/hybrid
  3. Job type: keep only data science, analytics, ML, AI related roles
  4. Aggregators: remove recruiter/aggregator companies
  5. Duplicates: keep one per company+title
  6. Cap per company: max 5 listings per company
"""

import csv
import re
import sys
from pathlib import Path

# -- Filter config --

SENIOR_KEYWORDS = [
    "senior", "sr.", "sr ", "lead", "principal", "staff",
    "head of", "director", "vp ", "vice president", "chief",
]

RELEVANT_TITLE_KEYWORDS = [
    "data sci", "data analy", "analytics", "machine learn",
    "ml ", "ml/", "ai ", "ai/", "deep learn", "nlp",
    "business intel", "bi ", "statistician", "data engineer",
    "research scien", "quantitative", "computer vision",
    "artificial intelligence", "applied scien",
]

RELEVANT_DESC_KEYWORDS = [
    "data scien", "machine learn", "data analy", "analytics",
    "statistical model", "predictive model", "deep learn",
    "natural language", "computer vision",
]

AGGREGATOR_COMPANIES = [
    "jobgether", "hire feed", "hired", "crossover", "turing",
    "toptal", "andela", "talent.com", "jobot",
]

MAX_PER_COMPANY = 5


def is_senior(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in SENIOR_KEYWORDS)


def is_relevant_role(title: str, description: str) -> bool:
    t = title.lower()
    # Normalize unicode characters (some titles use fancy unicode)
    t_normalized = t.encode("ascii", "ignore").decode("ascii").lower()

    if any(kw in t for kw in RELEVANT_TITLE_KEYWORDS):
        return True
    if any(kw in t_normalized for kw in RELEVANT_TITLE_KEYWORDS):
        return True

    # Fallback: check description for strong signals
    d = description.lower()[:2000]
    matches = sum(1 for kw in RELEVANT_DESC_KEYWORDS if kw in d)
    return matches >= 2


def classify_work_arrangement(title: str, description: str) -> str:
    """Returns 'remote', 'hybrid', 'onsite', or 'unknown'."""
    t = title.lower()
    d = description.lower()

    remote_kw = ["remote", "fully remote", "work from home", "wfh",
                 "telecommut", "remoto", "teletrabajo"]
    hybrid_kw = ["hybrid", "híbrido"]
    onsite_kw = ["on-site", "onsite", "in-office", "office-based",
                 "office based", "in office", "presencial"]

    full = t + " " + d

    has_remote = any(kw in full for kw in remote_kw)
    has_hybrid = any(kw in full for kw in hybrid_kw)
    has_onsite = any(kw in full for kw in onsite_kw)

    # If explicitly onsite/hybrid without mentioning remote, exclude
    if has_onsite and not has_remote:
        return "onsite"
    if has_hybrid and not has_remote:
        return "hybrid"
    if has_remote:
        return "remote"

    # No keywords found — since the original search was for remote,
    # give benefit of the doubt
    return "unknown"


def is_remote(title: str, description: str) -> bool:
    arrangement = classify_work_arrangement(title, description)
    # Keep remote and unknown (benefit of the doubt from remote search)
    # Exclude only explicitly onsite or hybrid-only
    return arrangement in ("remote", "unknown")


def filter_jobs(input_path: str) -> None:
    input_file = Path(input_path)
    if not input_file.exists():
        print(f"File not found: {input_file}")
        sys.exit(1)

    with open(input_file, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    total = len(rows)
    stats = {
        "senior": 0, "not_relevant": 0, "onsite": 0,
        "hybrid": 0, "aggregator": 0, "duplicate": 0, "capped": 0,
    }

    # Pass 1: content-based filters
    passed = []
    for row in rows:
        title = row["Title"]
        desc = row["Description"]
        company = row["Company Name"]

        if is_senior(title):
            stats["senior"] += 1
            continue

        if not is_relevant_role(title, desc):
            stats["not_relevant"] += 1
            continue

        arrangement = classify_work_arrangement(title, desc)
        if arrangement == "onsite":
            stats["onsite"] += 1
            continue
        if arrangement == "hybrid":
            stats["hybrid"] += 1
            continue

        if company.lower().strip() in AGGREGATOR_COMPANIES:
            stats["aggregator"] += 1
            continue

        passed.append(row)

    # Pass 2: deduplicate (same company + title, keep first)
    seen_combos = set()
    deduped = []
    for row in passed:
        key = (row["Company Name"].lower().strip(), row["Title"].lower().strip())
        if key in seen_combos:
            stats["duplicate"] += 1
            continue
        seen_combos.add(key)
        deduped.append(row)

    # Pass 3: cap per company
    from collections import Counter
    company_counts = Counter()
    filtered = []
    for row in deduped:
        company = row["Company Name"].lower().strip()
        if company_counts[company] >= MAX_PER_COMPANY:
            stats["capped"] += 1
            continue
        company_counts[company] += 1
        filtered.append(row)

    # Write filtered output
    stem = input_file.stem
    output_file = input_file.parent / f"{stem}-filtered.csv"

    with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(filtered)

    print(f"Original:         {total} jobs")
    print(f"Removed senior:   {stats['senior']}")
    print(f"Removed irrelevant: {stats['not_relevant']}")
    print(f"Removed onsite:   {stats['onsite']}")
    print(f"Removed hybrid:   {stats['hybrid']}")
    print(f"Removed aggregator: {stats['aggregator']}")
    print(f"Removed duplicate: {stats['duplicate']}")
    print(f"Removed capped:   {stats['capped']}")
    print(f"Filtered:         {len(filtered)} jobs")
    print(f"Saved to:         {output_file}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        filter_jobs(sys.argv[1])
    else:
        # Default: filter the latest CSV in outputs/
        outputs = Path(__file__).parent / "outputs"
        csvs = sorted(outputs.glob("linkedin-jobs-*.csv"), key=lambda p: p.stat().st_mtime)
        # Exclude already-filtered files
        csvs = [c for c in csvs if "-filtered" not in c.stem]
        if not csvs:
            print("No CSV files found in outputs/")
            sys.exit(1)
        filter_jobs(str(csvs[-1]))

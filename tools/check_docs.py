"""Do the documents still describe the code?

    python tools/check_docs.py


Written because a regex once ate two requirements and a README table silently
failed to update, and neither was noticed by reading. This compares what the
source actually contains against what the documents claim.
"""
import re
import sys
from pathlib import Path

ROOT = Path(r"D:\Projects\MarathonTracker\racetime\racetime")
MAIN = (ROOT / "backend" / "main.py").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
REQS = (ROOT / "docs" / "REQUIREMENTS.md").read_text(encoding="utf-8")
DOCS = README + "\n" + REQS

problems = []

# ---- every API route is documented somewhere --------------------------------
routes = sorted(set(re.findall(r'@app\.(get|post|patch|delete|put)\("([^"]+)"', MAIN)))
api_routes = [(m, p) for m, p in routes if p.startswith("/api/")]
undocumented = []
for method, path in api_routes:
    # Compare on the literal path; the tables print it verbatim in backticks.
    if f"`{path}`" not in DOCS:
        undocumented.append(f"{method.upper():<6} {path}")
print(f"1. API routes: {len(api_routes)} defined")
if undocumented:
    print("   NOT IN ANY DOCUMENT:")
    for r in undocumented:
        print(f"     {r}")
    problems.append(f"{len(undocumented)} API routes are undocumented")
else:
    print("   all documented")

# ---- every page exists and is mentioned -------------------------------------
pages = sorted(p.name for p in (ROOT / "static").glob("*.html"))
missing_pages = [p for p in pages if f"/{p}" not in DOCS and p != "index.html"]
print(f"2. Pages: {len(pages)} -> {', '.join(pages)}")
if missing_pages:
    print(f"   NOT MENTIONED: {missing_pages}")
    problems.append(f"pages not mentioned: {missing_pages}")
else:
    print("   all mentioned")

# ---- environment variables --------------------------------------------------
env_used = sorted(set(re.findall(r'os\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"',
                                 "\n".join((ROOT / "backend" / f).read_text(encoding="utf-8")
                                           for f in ("main.py", "db.py", "auth.py",
                                                     "mail.py", "analytics.py",
                                                     "notices.py")))))
# Ones the platform sets, not ones an organiser configures.
PLATFORM = {"VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "FUNCTION_TARGET", "PORT",
            "AWS_EXECUTION_ENV", "K_SERVICE", "DYNO", "RAILWAY_ENVIRONMENT",
            "RENDER", "FLY_APP_NAME"}
env_used = [e for e in env_used if e not in PLATFORM]
missing_env = [e for e in env_used if e not in DOCS]
print(f"3. Environment variables: {len(env_used)} read -> {', '.join(env_used)}")
if missing_env:
    print(f"   NOT DOCUMENTED: {missing_env}")
    problems.append(f"env vars undocumented: {missing_env}")
else:
    print("   all documented")

# ---- requirement numbering --------------------------------------------------
frs = re.findall(r"^### (FR-[\w.]+)", REQS, re.M)
dupes = {f for f in frs if frs.count(f) > 1}
print(f"4. Requirement sections: {len(frs)}")
if dupes:
    print(f"   DUPLICATED: {sorted(dupes)}")
    problems.append(f"duplicate requirement headings: {sorted(dupes)}")
else:
    print("   no duplicate headings")

# ---- table of contents ------------------------------------------------------
headings = re.findall(r"^## (.+)$", README, re.M)
toc_block = README.split("## Contents", 1)[-1].split("---", 1)[0]
toc = re.findall(r"^- \[(.+?)\]", toc_block, re.M)
skip = {"Contents", "Licence"}
missing_toc = [h for h in headings if h not in skip and h not in toc]
print(f"5. README sections: {len(headings)}, listed in contents: {len(toc)}")
if missing_toc:
    print(f"   NOT IN CONTENTS: {missing_toc}")
    problems.append(f"sections missing from contents: {missing_toc}")
else:
    print("   contents is complete")

# ---- claims that have gone stale -------------------------------------------
stale = []
for phrase, why in [
    ("X-Admin-Token", "the shared token header is gone"),
    ("two roles", "there are three roles now"),
    ("29 routes", "the route count has changed"),
    ("24 endpoints", "the endpoint count has changed"),
    ("Five tables", "the table count has changed"),
    ("Authentication, online registration", "both are built now"),
    ("ADMIN_TOKEN is not set", "there is no shared token any more"),
    ("One shared admin token", "accounts and roles replaced it"),
    ("not named logins", "the logins are named now"),
    ("180 assertions", "the suites have grown"),
    ("325 assertions", "the suites have grown again"),
    ("Virtual races | Not built", "virtual races are built"),
    ("13 tables", "the table count has changed"),
    ("14 tables", "the table count has changed"),
    ("Roles are also global rather than per-event",
     "races have named operators now"),
    ("Per-event roles | Not built", "per-race admins are built"),
    ("642 assertions", "the suites have grown again"),
    ("720 assertions", "the suites have grown again"),
    ("729 assertions", "the suites have grown again"),
    ("Checkpoint device credentials | Not built",
     "a per-race checkpoint code is built"),
    ("The checkpoint screen has no credentials",
     "a per-race checkpoint code is built"),
    ("While nobody is named, every", "a race with nobody named is closed now"),
    ("Race photography | Not built", "races carry a photograph now"),
    ("SMS / email notification | Not built", "email notices are built"),
    ("10 tables", "the table count has changed"),
]:
    if phrase in DOCS:
        stale.append(f"{phrase!r} ({why})")
print("6. Stale claims")
if stale:
    for s in stale:
        print(f"   FOUND: {s}")
    problems.append(f"stale claims: {stale}")
else:
    print("   none found")

print("=" * 62)
if problems:
    for p in problems:
        print(f"  [FAIL] {p}")
    sys.exit(1)
print("  [PASS] the documents match the code")

#!/usr/bin/env python3
"""
Build public/coffee.json from the two Coffee Brand Coffee scanners.

Inputs (both outside this repo, on OneDrive; override with env vars):
  COFFEE_AMAZON_CSV    StockTracker/tracker_data/history.csv
                       date,time,asin,label,available,price,status  (1 row per SKU per run)
  COFFEE_AMAZON_CATALOG StockTracker/tracker_data/products.json  (asin -> canonical label)
  COFFEE_SHOPIFY_CSV   ShopifyTracker/data/shopify_history.csv
                       date,time,product,variant,price,compare_at,stock,status

What this does is CLEANING and ALIGNMENT only. Every derived figure (units sold,
restocks, revenue, margin) is computed in the page from the aligned series, so
the controls there (period, margin, bulk-drop handling) can recompute live.

Cleaning rules, and why:
  * One reading per SKU per day: the LAST by time. Catch-up runs produce a second
    reading on ~4% of SKU-days; the later one is the better-rested read.
  * Amazon "available" is an exact count only when numeric. Blank (no stock
    signal / read failed / timeout) and the ">=30" floor guess are both emitted
    as null - "unknown that day" - and the page skips such days when it
    differences stock. Treating a floor as a number would invent sales.
  * "out of stock" rows carry available=0, which IS a real reading (zero).
  * Amazon price: a per-SKU MODAL in-stock price is emitted alongside the daily
    price series. About a third of listings flap between $19.99 and $85 because
    the scraper reads whichever size variant Amazon puts in the buy box, most
    often the 5 lb one while the 12 oz is out of stock. The daily series keeps
    the raw reads for the price log; valuations use the modal figure.
  * Size is not in the Amazon label (the same name is listed once per size), so
    it is inferred: K-Cups -> 12-pack, "Kona" -> 7oz, modal price >= $45 -> 5lb,
    else 12oz.
  * Shopify stock comes from the cart clamp and CAPS AT 80 (the per-order limit),
    so 80 means "at least 80". It is emitted as 80 with cap:80 in the channel
    meta; the page treats a capped reading as a floor and never differences
    across it. sold_out -> 0. untracked / rate_limited / clamp_unparsed -> null.

Usage:
  python scripts/build-coffee.py            # write public/coffee.json, print a summary
  python scripts/build-coffee.py --commit   # + git add/commit/push to main (daily task)
"""
import csv, json, os, re, sys, subprocess, collections, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "coffee.json"
ONEDRIVE = Path(os.environ.get("USERPROFILE", "C:/Users/bradw")) / "OneDrive" / "Desktop" / "Project FIles" / "StockTracker"
AMAZON_CSV = Path(os.environ.get("COFFEE_AMAZON_CSV", ONEDRIVE / "StockTracker" / "tracker_data" / "history.csv"))
AMAZON_CATALOG = Path(os.environ.get("COFFEE_AMAZON_CATALOG", ONEDRIVE / "StockTracker" / "tracker_data" / "products.json"))
SHOPIFY_CSV = Path(os.environ.get("COFFEE_SHOPIFY_CSV", ONEDRIVE / "ShopifyTracker" / "data" / "shopify_history.csv"))
SHOPIFY_CAP = 80
COMMIT = "--commit" in sys.argv


def log(msg):
    print(f"[build-coffee] {msg}", flush=True)


def money(s):
    s = (s or "").strip().replace("$", "").replace(",", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def mode(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    c = collections.Counter(values)
    top = max(c.values())
    # tie -> the lower price (the 12 oz default, not the 5 lb variant)
    return min(v for v, n in c.items() if n == top)


def tidy(label):
    return (label or "").replace("\ufffd", "'").replace("\u2019", "'").strip()


# ---------------------------------------------------------------- Amazon ---
def build_amazon():
    if not AMAZON_CSV.exists():
        log(f"Amazon history not found: {AMAZON_CSV}")
        return None
    catalog = {}
    if AMAZON_CATALOG.exists():
        for p in json.load(open(AMAZON_CATALOG, encoding="utf-8")):
            catalog[p["asin"]] = tidy(p.get("label"))
    rows = list(csv.DictReader(open(AMAZON_CSV, encoding="utf-8", errors="replace")))
    rows.sort(key=lambda r: (r["date"], r["time"]))
    by = collections.defaultdict(dict)          # asin -> date -> row (last wins)
    last_label = {}
    for r in rows:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["date"] or ""):
            continue
        by[r["asin"]][r["date"]] = r
        if r.get("label"):
            last_label[r["asin"]] = tidy(r["label"])
    days = sorted({d for a in by.values() for d in a})
    skus = []
    for asin, per_day in by.items():
        label = catalog.get(asin) or last_label.get(asin) or asin
        family, _, name = label.partition(" - ")
        if not name:
            family, name = "Other", label
        family = {"K-Cups": "K-Cups", "Ground": "Ground", "Whole Bean": "Whole Bean"}.get(family.strip(), "Other")
        stock, prices, statuses = [], [], []
        for d in days:
            r = per_day.get(d)
            if r is None:
                stock.append(None); prices.append(None); continue
            av = (r.get("available") or "").strip()
            stock.append(int(av) if re.fullmatch(r"\d+", av) else None)
            prices.append(money(r.get("price")))
            statuses.append((r.get("status") or "").strip())
        in_stock_prices = [p for p, s, r in zip(prices, stock, [per_day.get(d) for d in days])
                           if p is not None and s and (r.get("status") or "").startswith("ok")]
        price = mode(in_stock_prices) if in_stock_prices else mode(prices)
        if family == "K-Cups":
            size = "12-pack"
        elif "kona" in name.lower():
            size = "7oz"
        elif price is not None and price >= 45:
            size = "5lb"
        else:
            size = "12oz"
        known = [d for d, s in zip(days, stock) if s is not None]
        skus.append({
            "id": asin, "name": name.strip(), "family": family, "size": size,
            "price": price, "url": f"https://www.amazon.com/dp/{asin}",
            "stock": stock, "prices": prices,
            "lastReading": known[-1] if known else None,
        })
    skus.sort(key=lambda s: (s["family"], s["name"], s["size"]))
    return {"days": days, "skus": skus, "cap": None, "scan": "daily ~09:30 UK, one read per listing"}


# --------------------------------------------------------------- Shopify ---
def build_shopify():
    if not SHOPIFY_CSV.exists():
        log(f"Shopify history not found: {SHOPIFY_CSV}")
        return None
    rows = list(csv.DictReader(open(SHOPIFY_CSV, encoding="utf-8", errors="replace")))
    rows.sort(key=lambda r: (r["date"], r["time"]))
    by = collections.defaultdict(dict)
    for r in rows:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["date"] or ""):
            continue
        by[(tidy(r["product"]), tidy(r["variant"]))][r["date"]] = r
    days = sorted({d for a in by.values() for d in a})
    skus = []
    for (product, variant), per_day in by.items():
        v = variant.lower()
        if "12 pack" in v or "kcup" in product.lower():
            family = "K-Cups"
        elif "whole bean" in v:
            family = "Whole Bean"
        elif "ground" in v:
            family = "Ground"
        else:
            family = "Other"
        size = ("5lb" if "5lb" in v else "7oz" if "7oz" in v else "12oz" if "12oz" in v
                else "12-pack" if family == "K-Cups" else "")
        stock, prices, compare = [], [], []
        for d in days:
            r = per_day.get(d)
            if r is None:
                stock.append(None); prices.append(None); compare.append(None); continue
            st = (r.get("status") or "").strip()
            sv = (r.get("stock") or "").strip()
            if st == "in_stock" and re.fullmatch(r"\d+", sv):
                stock.append(int(sv))
            elif st == "sold_out":
                stock.append(0)
            else:
                stock.append(None)
            prices.append(money(r.get("price")))
            c = money(r.get("compare_at"))
            compare.append(c if c and prices[-1] is not None and c > prices[-1] else None)
        latest_price = next((p for p in reversed(prices) if p is not None), None)
        known = [d for d, s in zip(days, stock) if s is not None]
        skus.append({
            "id": f"{product} / {variant}", "name": product, "variant": variant,
            "family": family, "size": size, "price": latest_price,
            "url": "https://coffeebrandcoffee.com/",
            "stock": stock, "prices": prices, "compareAt": compare,
            "lastReading": known[-1] if known else None,
        })
    skus.sort(key=lambda s: (s["family"], s["name"], s["size"], s["variant"]))
    return {"days": days, "skus": skus, "cap": SHOPIFY_CAP, "scan": "daily ~12:00 UK, exact count via cart limit (caps at 80)"}


# ------------------------------------------------------------------ main ---
def main():
    amazon = build_amazon()
    shopify = build_shopify()
    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "amazon": amazon,
        "shopify": shopify,
    }
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    old = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    # only the timestamp changed -> don't churn a commit for nothing
    strip = lambda t: re.sub(r'"generated":"[^"]*"', "", t)
    changed = strip(old) != strip(text)
    if changed or not OUT.exists():
        OUT.write_text(text, encoding="utf-8")
    for name, ch in (("amazon", amazon), ("shopify", shopify)):
        if ch:
            n_known = sum(1 for s in ch["skus"] for v in s["stock"] if v is not None)
            log(f"{name}: {len(ch['skus'])} SKUs x {len(ch['days'])} days ({ch['days'][0]} .. {ch['days'][-1]}), {n_known} exact readings")
    log(f"{'wrote' if changed else 'unchanged'} {OUT.relative_to(ROOT)} ({len(text)//1024} KB)")

    if not COMMIT:
        return 0
    if not changed:
        log("nothing to commit")
        return 0
    branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if branch != "main":
        log(f"ABORT commit: repo is on '{branch}', not main (data goes to main only)")
        return 2
    subprocess.run(["git", "add", "public/coffee.json"], cwd=ROOT, check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode == 0:
        log("nothing staged")
        return 0
    msg = f"chore: coffee data ({datetime.date.today().isoformat()})"
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=ROOT, check=True)
    for attempt in range(3):   # bots push to main ~10x/day; retry the race
        rb = subprocess.run(["git", "pull", "--rebase", "origin", "main", "-q"], cwd=ROOT)
        if rb.returncode != 0:
            subprocess.run(["git", "rebase", "--abort"], cwd=ROOT)
            log("ABORT push: rebase conflict on pull; commit left local, repo restored.")
            return 3
        if subprocess.run(["git", "push", "-q", "origin", "main"], cwd=ROOT).returncode == 0:
            log(f"committed and pushed: {msg}")
            return 0
    log("push failed after 3 attempts; commit left local")
    return 4


if __name__ == "__main__":
    sys.exit(main())

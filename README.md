# TheQuartering channel analytics

A small, public-facing dashboard tracking long-form vs Shorts performance for [TheQuartering](https://www.youtube.com/@TheQuartering). Data refreshes nightly.

## How it works

- A GitHub Action runs nightly at 03:00 UTC
- It calls the YouTube Data API, fetches recent uploads + view stats
- It merges fresh data into `public/data.json` and commits the result
- Cloudflare Pages (or wherever you host) auto-redeploys from the new commit
- Visitors load `index.html` which reads from `data.json` — zero YouTube API calls per visit

API quota cost: ~30-40 units on first run, ~2-3 units per nightly run. The daily free quota is 10,000 units, so this uses well under 0.1% of it.

## Project structure

```
.
├── .github/workflows/
│   └── update-data.yml      # nightly job config
├── public/
│   ├── index.html           # the static site
│   └── data.json            # the dataset (auto-updated)
├── scripts/
│   └── fetch-data.js        # the fetcher
└── README.md
```

## Deploying — first time setup

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:YOUR_USERNAME/yt-tracker.git
git push -u origin main
```

The repo can be public or private. Public is simpler if you also want free GitHub Actions minutes.

### 2. Add your YouTube API key as a secret

In your GitHub repo:
1. Settings → Secrets and variables → Actions
2. Click **New repository secret**
3. Name: `YOUTUBE_API_KEY`
4. Value: your YouTube Data API key (the one you've been using)
5. Save

This stores the key encrypted; it's only available to the GitHub Action, never exposed publicly.

### 3. Run the fetcher manually for the first time

The nightly cron starts running automatically, but to populate data immediately:

1. Go to the **Actions** tab in your GitHub repo
2. Click **Update channel data** in the left sidebar
3. Click **Run workflow** → **Run workflow** (button on the right)
4. Wait ~30 seconds; it'll commit `public/data.json` to your repo

### 4. Set up Cloudflare Pages

1. Sign up at [pages.cloudflare.com](https://pages.cloudflare.com/) (free, no card needed)
2. Click **Create a project** → **Connect to Git** → authorise GitHub → pick this repo
3. Build settings:
   - **Build command:** leave empty
   - **Build output directory:** `public`
4. Click **Save and Deploy**

Cloudflare gives you a URL like `yt-tracker.pages.dev`. You can add a custom domain later under the Pages project settings.

Every time the nightly job commits new data, Cloudflare rebuilds and re-publishes within a minute or two.

## Running the fetcher locally

For testing or debugging:

```bash
export YOUTUBE_API_KEY="AIza..."
node scripts/fetch-data.js
```

It'll write to `public/data.json` and you can open `public/index.html` in a browser to preview.

## Customising

- **Change the channel:** edit `CHANNEL_HANDLE` at the top of `scripts/fetch-data.js`
- **Change the Shorts cutoff:** edit `SHORTS_CUTOFF_SEC` (currently 180s = 3 min)
- **Change the schedule:** edit the cron expression in `.github/workflows/update-data.yml`
- **Change how far back is fetched on first run:** edit `HISTORY_YEARS`

## Cost

- GitHub: free (Actions for public repos are free; 2000 min/month for private)
- Cloudflare Pages: free
- YouTube API: free (well within quota)
- Domain (optional): ~£10/year if you want a custom one

Total: £0–10/year.

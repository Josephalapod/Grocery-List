# Grocery List PWA

A mobile-first grocery shopping app with recipe import, smart ingredient merging, and offline support.

## Setup on GitHub Pages (5 minutes)

### 1. Create a new repository
- Go to [github.com/new](https://github.com/new)
- Name it `grocery-list` (or whatever you prefer)
- Make it **Public** (required for free GitHub Pages)
- Click **Create repository**

### 2. Upload the files
- Click **"uploading an existing file"** link on the new repo page
- Drag and drop ALL 5 files from this folder:
  - `index.html`
  - `manifest.json`
  - `sw.js`
  - `icon-192.png`
  - `icon-512.png`
- Click **Commit changes**

### 3. Enable GitHub Pages
- Go to your repo's **Settings** tab
- Click **Pages** in the left sidebar
- Under "Source", select **Deploy from a branch**
- Select **main** branch and **/ (root)** folder
- Click **Save**
- Wait 1-2 minutes for it to deploy

### 4. Install on your phone
- Open Chrome on your phone
- Go to `https://YOUR-USERNAME.github.io/grocery-list/`
- Chrome should show an **"Add to Home Screen"** banner
- If not, tap the **⋮** menu → **"Add to Home Screen"** or **"Install app"**
- The app icon will appear on your home screen!

## Features
- ✅ Tap checkboxes to strike through items
- 📖 Paste recipe URLs to auto-extract ingredients
- 🔄 Smart quantity merging across recipes (converts units)
- 📱 Works offline after first load
- 💾 All data saved locally on your device
- 🧹 Clear list without losing saved recipes
- ➕ Toggle recipes on/off to add/remove ingredients

## Updating the app
If you get an updated `index.html` from Claude, just replace the file in your GitHub repo.
The service worker will auto-update on your phone next time you open the app.

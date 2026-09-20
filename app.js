const APP_VERSION = 'v1.6.0';

const CATEGORIES = [
  { id: 'produce', name: 'Produce', color: '#3B9E3F', defaults: ['Bananas', 'Apples', 'Spinach', 'Tomatoes', 'Onions'] },
  { id: 'dairy', name: 'Dairy & Eggs', color: '#2979C9', defaults: ['Milk', 'Eggs', 'Butter', 'Shredded Cheese'] },
  { id: 'meat', name: 'Meat & Seafood', color: '#D43D2F', defaults: ['Chicken Breast', 'Ground Beef'] },
  { id: 'bakery', name: 'Bakery & Bread', color: '#E8960C', defaults: ['Sliced Bread', 'Tortillas'] },
  { id: 'pantry', name: 'Pantry & Dry Goods', color: '#7B3FA0', defaults: ['Rice', 'Pasta', 'Olive Oil', 'Canned Tomatoes'] },
  { id: 'frozen', name: 'Frozen', color: '#0097A7', defaults: ['Frozen Veggies', 'Ice Cream'] },
  { id: 'beverages', name: 'Beverages', color: '#E67B09', defaults: ['Coffee', 'Orange Juice'] },
  { id: 'snacks', name: 'Snacks', color: '#C62757', defaults: ['Chips', 'Granola Bars'] },
  { id: 'household', name: 'Household & Other', color: '#546E7A', defaults: ['Paper Towels', 'Dish Soap'] },
];

let state = loadState();
let collapsed = {};

// --- Settings (persisted in localStorage) ---
let settings = loadSettings();

// Apply dark mode ASAP to avoid a flash of light theme
if (settings.darkMode) document.body.classList.add('dark');

function loadSettings() {
  let s = null;
  try {
    const saved = localStorage.getItem('grocerySettings');
    if (saved) s = JSON.parse(saved);
  } catch(e) {}
  s = s || {};
  // Fill in any keys added in later versions
  if (s.sinkChecked === undefined) s.sinkChecked = false;
  if (s.darkMode === undefined) s.darkMode = false;
  if (s.categoryOrder === undefined) s.categoryOrder = null;
  if (!s.categoryOverrides || typeof s.categoryOverrides !== 'object') s.categoryOverrides = {};  // normKey → category id
  if (!s.nameOverrides || typeof s.nameOverrides !== 'object') s.nameOverrides = {};          // normKey → display name
  if (!Array.isArray(s.staples)) s.staples = [];
  if (!s.purchaseOverrides || typeof s.purchaseOverrides !== 'object') s.purchaseOverrides = {};   // normKey → what to buy                                               // normKeys auto-checked from recipes
  return s;
}

function saveSettings() {
  const json = JSON.stringify(settings);
  try { localStorage.setItem('grocerySettings', json); } catch(e) {}
  if (typeof idbSet === 'function') idbSet('grocerySettings', json);
}

// Multiply a quantity string by a factor: "1 ½ cup" × 2 → "3 cup", "4" × 0.5 → "2"
function scaleQty(qty, factor) {
  if (!qty || !factor || factor === 1) return qty || '';
  const p = parseQty(qty);
  if (!p || !p.amount) return qty;
  const unit = normalizeUnit(p.unit);
  const amt = p.amount * factor;
  return unit ? `${formatAmount(amt)} ${unit}` : formatAmount(amt);
}

// Effective multiplier for a recipe (user's chosen scale, default 1)
function recipeFactor(recipe) {
  const f = parseFloat(recipe.scale);
  return (f > 0 && isFinite(f)) ? f : 1;
}

// Returns categories in the user's custom order (falls back to default order)
function orderedCategories() {
  if (!settings.categoryOrder || !Array.isArray(settings.categoryOrder)) return CATEGORIES.slice();
  const byId = {};
  CATEGORIES.forEach(c => { byId[c.id] = c; });
  const ordered = [];
  settings.categoryOrder.forEach(id => { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
  // Append any categories not in the saved order (e.g. if categories were added later)
  CATEGORIES.forEach(c => { if (byId[c.id]) ordered.push(c); });
  return ordered;
}

function moveCategory(catId, direction) {
  const order = orderedCategories().map(c => c.id);
  const idx = order.indexOf(catId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  settings.categoryOrder = order;
  saveSettings();
  render();
}

// --- Durable storage layer (IndexedDB + localStorage mirror) ---
// IndexedDB survives "clear cached files" and is much harder to lose than localStorage.
// We write to both so reads are instant (localStorage) but data is durable (IndexedDB).
let idb = null;

function openIDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('groceryAppDB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };
      req.onsuccess = (e) => { idb = e.target.result; resolve(idb); };
      req.onerror = () => resolve(null);
    } catch(e) { resolve(null); }
  });
}

function idbSet(key, value) {
  if (!idb) return;
  try {
    const tx = idb.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
  } catch(e) {}
}

function idbGet(key) {
  return new Promise((resolve) => {
    if (!idb) { resolve(null); return; }
    try {
      const tx = idb.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch(e) { resolve(null); }
  });
}

// Durable write: mirror to both localStorage (fast) and IndexedDB (durable)
function durableSet(key, jsonString) {
  try { localStorage.setItem(key, jsonString); } catch(e) {}
  idbSet(key, jsonString);
}

function loadState() {
  try {
    const saved = localStorage.getItem('groceryList');
    if (saved) return JSON.parse(saved);
  } catch(e) {}
  return initState();
}

function initState() {
  const s = {};
  CATEGORIES.forEach(cat => {
    s[cat.id] = cat.defaults.map(name => ({ name, qty: '', checked: false, id: uid() }));
  });
  return s;
}

function saveState() {
  durableSet('groceryList', JSON.stringify(state));
}

function uid() {
  return Math.random().toString(36).substr(2, 9);
}

// --- Recipes ---
let recipes = loadRecipes();
let recipesCollapsed = false;

function loadRecipes() {
  try {
    const saved = localStorage.getItem('groceryRecipes');
    if (saved) return JSON.parse(saved);
  } catch(e) {}
  return [];
}

function saveRecipes() {
  durableSet('groceryRecipes', JSON.stringify(recipes));
}

function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace('www.', '');
  } catch(e) {
    return url;
  }
}

function setRecipeScale(recipe, factor) {
  recipe.scale = Math.round(factor * 100) / 100;
  saveRecipes();
  if (recipe.active) rebuildGroceryList();
  renderRecipes();
  render();
}

function renderRecipes() {
  const container = document.getElementById('recipesSection');
  container.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'recipes-section';

  // Header
  const header = document.createElement('div');
  header.className = 'recipes-header' + (recipesCollapsed ? ' collapsed' : '');
  header.innerHTML = `
    <h2>📖 Recipes</h2>
    <span class="cat-chevron">▾</span>
  `;
  header.onclick = () => {
    recipesCollapsed = !recipesCollapsed;
    renderRecipes();
  };
  section.appendChild(header);

  if (!recipesCollapsed) {
    const body = document.createElement('div');
    body.className = 'recipes-body';

    // Recipe cards
    if (recipes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'recipe-empty';
      empty.textContent = 'No recipes yet — add one below!';
      body.appendChild(empty);
    }

    recipes.forEach((recipe, idx) => {
      const card = document.createElement('div');
      card.className = 'recipe-card';

      // Toggle button (add/remove ingredients)
      const toggle = document.createElement('button');
      toggle.className = 'recipe-toggle' + (recipe.active ? ' active' : '');
      toggle.innerHTML = recipe.active ? '✓' : '+';
      toggle.style.color = recipe.active ? '#fff' : '#ABABAB';
      toggle.onclick = (e) => {
        e.stopPropagation();
        recipe.active = !recipe.active;
        saveRecipes();
        rebuildGroceryList();
        renderRecipes();
        render();
      };
      card.appendChild(toggle);

      const info = document.createElement('div');
      info.className = 'recipe-info';
      info.style.cursor = 'pointer';

      const title = document.createElement('div');
      title.className = 'recipe-title';
      title.textContent = recipe.title;
      info.appendChild(title);

      const url = document.createElement('div');
      url.className = 'recipe-url';
      url.textContent = getDomain(recipe.url);
      info.appendChild(url);

      info.onclick = () => {
        window.open(recipe.url, '_blank');
      };

      // Servings / scale control
      const scaleRow = document.createElement('div');
      scaleRow.className = 'recipe-scale';
      scaleRow.onclick = (e) => e.stopPropagation();
      const factor = recipeFactor(recipe);
      const base = recipe.servings;
      const minus = document.createElement('button'); minus.textContent = '−';
      const plus = document.createElement('button'); plus.textContent = '+';
      const val = document.createElement('span'); val.className = 'scale-val';
      if (base) {
        const target = Math.max(1, Math.round(base * factor));
        val.textContent = `Serves ${target}`;
        minus.onclick = () => setRecipeScale(recipe, Math.max(1, target - 1) / base);
        plus.onclick = () => setRecipeScale(recipe, (target + 1) / base);
      } else {
        val.textContent = `Scale ${factor % 1 === 0 ? factor : factor.toFixed(1)}×`;
        minus.onclick = () => setRecipeScale(recipe, Math.max(0.5, factor - 0.5));
        plus.onclick = () => setRecipeScale(recipe, factor + 0.5);
      }
      scaleRow.appendChild(minus); scaleRow.appendChild(val); scaleRow.appendChild(plus);
      if (factor !== 1) {
        const reset = document.createElement('button');
        reset.textContent = '↺'; reset.title = 'Reset';
        reset.onclick = () => setRecipeScale(recipe, 1);
        scaleRow.appendChild(reset);
      }
      info.appendChild(scaleRow);

      card.appendChild(info);

      const del = document.createElement('button');
      del.className = 'recipe-delete';
      del.textContent = '×';
      del.onclick = (e) => {
        e.stopPropagation();
        const wasActive = recipe.active;
        recipes.splice(idx, 1);
        saveRecipes();
        if (wasActive) {
          rebuildGroceryList();
          render();
        }
        renderRecipes();
      };
      card.appendChild(del);

      body.appendChild(card);
    });

    // Add recipe form
    const form = document.createElement('div');
    form.className = 'recipe-add-form';

    const row1 = document.createElement('div');
    row1.className = 'recipe-add-row';
    const urlInput = document.createElement('input');
    urlInput.className = 'recipe-add-input';
    urlInput.type = 'url';
    urlInput.placeholder = 'Paste recipe URL...';
    urlInput.setAttribute('enterkeyhint', 'done');
    row1.appendChild(urlInput);

    const addBtn = document.createElement('button');
    addBtn.className = 'recipe-add-btn';
    addBtn.textContent = 'Add';
    row1.appendChild(addBtn);
    form.appendChild(row1);

    const statusEl = document.createElement('div');
    statusEl.className = 'recipe-status';
    statusEl.style.display = 'none';
    form.appendChild(statusEl);

    // Bulk add toggle
    const bulkToggle = document.createElement('div');
    bulkToggle.className = 'bulk-add-toggle';
    bulkToggle.textContent = '+ Bulk add multiple recipes';
    form.appendChild(bulkToggle);

    // Bulk add container (hidden by default)
    const bulkContainer = document.createElement('div');
    bulkContainer.style.display = 'none';

    const bulkTextarea = document.createElement('textarea');
    bulkTextarea.className = 'bulk-textarea';
    bulkTextarea.placeholder = 'Paste one URL per line...\n\nhttps://example.com/recipe-1\nhttps://example.com/recipe-2\nhttps://example.com/recipe-3';
    bulkContainer.appendChild(bulkTextarea);

    const bulkRow = document.createElement('div');
    bulkRow.className = 'recipe-add-row';
    bulkRow.style.marginTop = '8px';

    const bulkBtn = document.createElement('button');
    bulkBtn.className = 'recipe-add-btn';
    bulkBtn.style.width = '100%';
    bulkBtn.textContent = 'Add All Recipes';
    bulkRow.appendChild(bulkBtn);
    bulkContainer.appendChild(bulkRow);

    const bulkStatusEl = document.createElement('div');
    bulkStatusEl.className = 'recipe-status';
    bulkStatusEl.style.display = 'none';
    bulkContainer.appendChild(bulkStatusEl);

    form.appendChild(bulkContainer);

    bulkToggle.onclick = () => {
      const isOpen = bulkContainer.style.display !== 'none';
      bulkContainer.style.display = isOpen ? 'none' : 'block';
      bulkToggle.textContent = isOpen ? '+ Bulk add multiple recipes' : '− Hide bulk add';
    };

    async function bulkAddRecipes() {
      const text = bulkTextarea.value.trim();
      if (!text) return;

      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.length > 5)
        .map(line => line.match(/^https?:\/\//) ? line : 'https://' + line);

      if (urls.length === 0) return;

      bulkBtn.classList.add('loading');
      bulkBtn.textContent = '...';
      let added = 0;
      let failed = 0;

      for (let i = 0; i < urls.length; i++) {
        bulkStatusEl.textContent = `Processing ${i + 1} of ${urls.length}...`;
        bulkStatusEl.className = 'recipe-status';
        bulkStatusEl.style.display = 'block';

        // Check for duplicate URL
        if (recipes.some(r => r.url === urls[i])) {
          added++;
          continue;
        }

        try {
          // Reuse the same addRecipe logic but with a specific URL
          urlInput.value = urls[i];
          await addRecipe();
          added++;
        } catch(e) {
          failed++;
        }

        // Small delay between requests to avoid rate limiting
        if (i < urls.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      bulkBtn.classList.remove('loading');
      bulkBtn.textContent = 'Add All Recipes';
      bulkTextarea.value = '';

      const msg = `Done! Added ${added} recipe${added !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}.`;
      bulkStatusEl.textContent = msg;
      bulkStatusEl.style.display = 'block';
      setTimeout(() => { bulkStatusEl.style.display = 'none'; }, 5000);
    }

    bulkBtn.onclick = bulkAddRecipes;

    function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = 'recipe-status' + (isError ? ' error' : '');
      statusEl.style.display = 'block';
    }

    async function addRecipe() {
      const u = urlInput.value.trim();
      if (!u) return;

      const fullUrl = u.match(/^https?:\/\//) ? u : 'https://' + u;
      addBtn.classList.add('loading');
      addBtn.textContent = '...';
      showStatus('Fetching recipe...', false);

      try {
        // Try multiple fetch methods (ordered by reliability)
        // Jina Reader renders pages server-side and bypasses most bot-blocking.
        // We request HTML from Jina so we can use the robust JSON-LD extractor.
        const proxies = [
          { url: u => `https://r.jina.ai/${u}`, type: 'jina-html' },
          { url: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, type: 'html' },
          { url: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`, type: 'html' },
          { url: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, type: 'html' },
          { url: u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, type: 'json' },
          { url: u => `https://proxy.cors.sh/${u}`, type: 'html' },
          { url: u => `https://r.jina.ai/${u}`, type: 'jina-md' },
        ];

        let html = null;
        let jinaText = null;

        for (const proxy of proxies) {
          try {
            let headers = {};
            if (proxy.type === 'jina-html') headers = { 'X-Return-Format': 'html' };
            else if (proxy.type === 'jina-md') headers = { 'X-Return-Format': 'markdown' };

            const resp = await fetch(proxy.url(fullUrl), {
              signal: AbortSignal.timeout(15000),
              headers
            });
            if (resp.ok) {
              let text = await resp.text();
              if (proxy.type === 'json') {
                try { text = JSON.parse(text).contents || ''; } catch(e) {}
              }

              if (proxy.type === 'jina-html') {
                // Jina HTML may contain JSON-LD or recipe markup — route through the HTML pipeline
                if (text && text.length > 500 && (text.includes('recipeIngredient') || text.includes('<'))) {
                  html = text;
                  break;
                }
              } else if (proxy.type === 'jina-md') {
                if (text && text.length > 300) {
                  jinaText = text;
                  break;
                }
              } else if (text && text.length > 500 && text.includes('<')) {
                html = text;
                break;
              }
            }
          } catch(e) { /* try next proxy */ }
        }

        // If we only got Jina markdown (no HTML worked), parse it as a last resort
        if (!html && jinaText) {
          const jinaResult = extractFromMarkdown(jinaText);
          if (jinaResult && jinaResult.ingredients.length > 0) {
            const categorized = jinaResult.ingredients.map(raw => {
              const parsed = parseIngredientString(raw);
              return { name: parsed.name, qty: parsed.qty, category: categorizeIngredient(parsed.name, parsed.qty) };
            }).filter(ing => ing.name && ing.name.length >= 2 && !shouldExcludeIngredient(ing.name) && !isJustUnit(ing.name));

            if (categorized.length > 0) {
              addRecipeFromResult({ title: jinaResult.title || 'Recipe', ingredients: categorized }, fullUrl);
              return;
            }
          }
        }

        if (!html) {
          // Try the Claude API as fallback (works inside Claude's interface)
          try {
            const result = await extractWithAI(fullUrl);
            if (result) {
              addRecipeFromResult(result, fullUrl);
              return;
            }
          } catch(e) { /* fall through to manual */ }

          // All methods failed — show manual entry
          showManualEntry(fullUrl, form);
          return;
        }

        showStatus('Extracting ingredients...', false);

        // Parse the HTML and look for JSON-LD structured data
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
        let recipeData = null;

        jsonLdScripts.forEach(el => {
          try {
            const data = JSON.parse(el.textContent);
            const found = findRecipeInJsonLd(data);
            if (found) recipeData = found;
          } catch(e) {}
        });

        // Fallback: look for microdata or common recipe markup
        if (!recipeData) {
          recipeData = extractFromHtml(doc);
        }

        if (!recipeData || !recipeData.ingredients || recipeData.ingredients.length === 0) {
          // Try AI fallback
          try {
            const result = await extractWithAI(fullUrl);
            if (result) {
              addRecipeFromResult(result, fullUrl);
              return;
            }
          } catch(e) {}

          showManualEntry(fullUrl, form);
          return;
        }

        // Categorize ingredients locally
        const categorized = recipeData.ingredients.map(raw => {
          const parsed = parseIngredientString(raw);
          return {
            name: parsed.name,
            qty: parsed.qty,
            category: categorizeIngredient(parsed.name, parsed.qty)
          };
        }).filter(ing => ing.name && ing.name.length >= 2 && !shouldExcludeIngredient(ing.name) && !isJustUnit(ing.name));

        addRecipeFromResult({
          title: recipeData.title || 'Untitled Recipe',
          ingredients: categorized
        }, fullUrl);

      } catch(e) {
        console.error(e);
        showStatus('Could not fetch recipe. Add ingredients manually below.', true);
        showManualEntry(fullUrl, form);
      } finally {
        addBtn.classList.remove('loading');
        addBtn.textContent = 'Add';
      }
    }

    // Try Claude API (works inside Claude interface, fails on standalone)
    async function extractWithAI(fullUrl) {
      const CATEGORY_IDS = CATEGORIES.map(c => c.id);
      const prompt = `Go to this recipe URL and extract the recipe title and all ingredients: ${fullUrl}

Categorize each ingredient into one of these grocery categories: ${CATEGORY_IDS.join(', ')}.

Respond ONLY with a JSON object (no markdown, no backticks, no explanation) in this exact format:
{
  "title": "Recipe Name",
  "ingredients": [
    {"name": "chicken breast", "qty": "2 lbs", "category": "meat"},
    {"name": "olive oil", "qty": "2 tbsp", "category": "pantry"}
  ]
}

Category mapping:
- produce: fruits, vegetables, fresh herbs, garlic, ginger, lemon, lime
- dairy: milk, cheese, eggs, butter, yogurt, cream
- meat: chicken, beef, pork, fish, salmon, shrimp, seafood, bacon, sausage
- bakery: bread, tortillas, rolls, buns, pita
- pantry: oil, vinegar, canned goods, pasta, rice, flour, sugar, spices, sauces, condiments, broth, stock, honey, soy sauce, sesame oil, cornstarch
- frozen: frozen vegetables, frozen meals, ice cream
- beverages: drinks, juice, coffee, tea, wine, beer
- snacks: chips, crackers, nuts, granola bars, cookies
- household: paper towels, soap, cleaning supplies, bags, foil, plastic wrap

Use simple common ingredient names (e.g. "salmon fillets" not "4 6-oz center-cut salmon fillets"). Put the full amount and unit in qty.`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!resp.ok) return null;

      const data = await resp.json();
      const textParts = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      const clean = textParts.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    }

    function addRecipeFromResult(result, fullUrl) {
      const CATEGORY_IDS = CATEGORIES.map(c => c.id);
      const filteredIngredients = (result.ingredients || [])
        .map(ing => ({
          name: cleanIngName(ing.name),
          qty: ing.qty || '',
          category: CATEGORY_IDS.includes(ing.category) ? ing.category : categorizeIngredient(ing.name)
        }))
        .filter(ing => ing.name && ing.name.length >= 2 && !shouldExcludeIngredient(ing.name) && !isJustUnit(ing.name));

      recipes.push({
        title: result.title || 'Untitled Recipe',
        url: fullUrl,
        id: uid(),
        active: true,
        ingredients: filteredIngredients,
        servings: result.servings || null,   // original yield from the site (may be unknown)
        scale: 1                              // multiplier the user has chosen
      });
      saveRecipes();
      rebuildGroceryList();

      const addedCount = filteredIngredients.length;
      showStatus(`Added "${result.title}" with ${addedCount} ingredients!`, false);
      urlInput.value = '';
      addBtn.classList.remove('loading');
      addBtn.textContent = 'Add';
      renderRecipes();
      render();
      setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
    }

    // Show manual ingredient entry form
    function showManualEntry(fullUrl, parentForm) {
      // Remove existing manual form if any
      const existing = parentForm.querySelector('.manual-ingredients');
      if (existing) existing.remove();

      addBtn.classList.remove('loading');
      addBtn.textContent = 'Add';

      const manual = document.createElement('div');
      manual.className = 'manual-ingredients';

      const titleLabel = document.createElement('div');
      titleLabel.className = 'manual-ingredients-title';
      titleLabel.textContent = 'Add ingredients manually';
      manual.appendChild(titleLabel);

      // Recipe title input
      const titleRow = document.createElement('div');
      titleRow.className = 'manual-ing-row';
      const titleInput = document.createElement('input');
      titleInput.className = 'manual-ing-name';
      titleInput.placeholder = 'Recipe name...';
      titleInput.style.fontWeight = '600';
      titleRow.appendChild(titleInput);
      manual.appendChild(titleRow);

      // Ingredient rows container
      const rowsContainer = document.createElement('div');

      function addIngRow(name, qty, category) {
        const row = document.createElement('div');
        row.className = 'manual-ing-row';

        const nameIn = document.createElement('input');
        nameIn.className = 'manual-ing-name';
        nameIn.placeholder = 'Ingredient...';
        nameIn.value = name || '';
        row.appendChild(nameIn);

        const qtyIn = document.createElement('input');
        qtyIn.className = 'manual-ing-qty';
        qtyIn.placeholder = 'qty';
        qtyIn.value = qty || '';
        row.appendChild(qtyIn);

        const catSel = document.createElement('select');
        catSel.className = 'manual-ing-cat';
        CATEGORIES.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = c.name;
          if (c.id === (category || 'pantry')) opt.selected = true;
          catSel.appendChild(opt);
        });
        row.appendChild(catSel);

        const delBtn = document.createElement('button');
        delBtn.className = 'recipe-delete';
        delBtn.textContent = '×';
        delBtn.onclick = () => row.remove();
        row.appendChild(delBtn);

        // Enter on name -> qty, Enter on qty -> next row
        nameIn.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); qtyIn.focus(); }
        });
        qtyIn.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addIngRow();
            const rows = rowsContainer.querySelectorAll('.manual-ing-row');
            const lastNameInput = rows[rows.length - 1].querySelector('.manual-ing-name');
            if (lastNameInput) lastNameInput.focus();
          }
        });

        rowsContainer.appendChild(row);
        return nameIn;
      }

      // Start with 3 empty rows
      addIngRow(); addIngRow(); addIngRow();
      manual.appendChild(rowsContainer);

      // Add more row button
      const addMoreBtn = document.createElement('button');
      addMoreBtn.className = 'recipe-add-btn';
      addMoreBtn.style.width = '100%';
      addMoreBtn.style.marginTop = '4px';
      addMoreBtn.style.background = 'var(--bg)';
      addMoreBtn.style.color = 'var(--text-muted)';
      addMoreBtn.style.border = '1.5px dashed var(--border)';
      addMoreBtn.textContent = '+ More ingredients';
      addMoreBtn.onclick = () => {
        const inp = addIngRow();
        inp.focus();
      };
      manual.appendChild(addMoreBtn);

      // Save button
      const saveBtn = document.createElement('button');
      saveBtn.className = 'manual-save-btn';
      saveBtn.textContent = 'Save Recipe';
      saveBtn.onclick = () => {
        const rows = rowsContainer.querySelectorAll('.manual-ing-row');
        const ingredients = [];
        rows.forEach(row => {
          const n = row.querySelector('.manual-ing-name').value.trim();
          const q = row.querySelector('.manual-ing-qty').value.trim();
          const c = row.querySelector('.manual-ing-cat').value;
          if (n) ingredients.push({ name: n, qty: q, category: c });
        });

        if (ingredients.length === 0) {
          showStatus('Add at least one ingredient.', true);
          return;
        }

        const rTitle = titleInput.value.trim() || 'Untitled Recipe';
        recipes.push({
          title: rTitle,
          url: fullUrl,
          id: uid(),
          active: true,
          ingredients,
          servings: null,
          scale: 1
        });
        saveRecipes();
        rebuildGroceryList();
        showStatus(`Added "${rTitle}" with ${ingredients.length} ingredients!`, false);
        urlInput.value = '';
        renderRecipes();
        render();
        setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
      };
      manual.appendChild(saveBtn);

      parentForm.appendChild(manual);
    }

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addRecipe(); }
    });
    addBtn.onclick = addRecipe;

    body.appendChild(form);
    section.appendChild(body);
  }

  container.appendChild(section);
}

// --- Recipe extraction helpers (no AI needed) ---

// Recursively find Recipe object in JSON-LD data
// Pull a servings number out of recipeYield: 4, "4", "4 servings", ["6", "6 servings"], "Serves 4-6"
function parseServings(y) {
  if (y == null) return null;
  if (Array.isArray(y)) { for (const v of y) { const n = parseServings(v); if (n) return n; } return null; }
  if (typeof y === 'number') return y > 0 && y < 200 ? y : null;
  const m = String(y).match(/(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 200 ? n : null;
}

function findRecipeInJsonLd(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findRecipeInJsonLd(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof data !== 'object') return null;

  const type = data['@type'];
  const isRecipe = type === 'Recipe' ||
    (Array.isArray(type) && type.includes('Recipe')) ||
    (typeof type === 'string' && type.toLowerCase() === 'recipe');

  if (isRecipe && data.recipeIngredient) {
    // recipeIngredient can be array of strings or array of objects
    let ingredients = data.recipeIngredient;
    if (Array.isArray(ingredients)) {
      ingredients = ingredients.map(ing => {
        if (typeof ing === 'string') return ing;
        if (ing && typeof ing === 'object') return ing.text || ing.name || '';
        return '';
      }).filter(Boolean);
    }
    return {
      title: (typeof data.name === 'string' ? data.name : '') || '',
      ingredients: ingredients,
      servings: parseServings(data.recipeYield)
    };
  }

  // Check @graph first (most common nesting)
  if (data['@graph']) {
    const r = findRecipeInJsonLd(data['@graph']);
    if (r) return r;
  }

  // Check nested values
  for (const val of Object.values(data)) {
    if (val && typeof val === 'object') {
      const r = findRecipeInJsonLd(val);
      if (r) return r;
    }
  }
  return null;
}

// Extract recipe from Jina Reader markdown output
function extractFromMarkdown(md) {
  if (!md) return null;

  let title = '';
  const titleMatch = md.match(/^#\s+(.+)$/m);
  if (titleMatch) title = titleMatch[1].trim();

  // Find the Ingredients section, capture until the next heading
  const ingSectionMatch = md.match(/#{2,4}\s*Ingredients\s*\n([\s\S]*?)(?=\n#{1,4}\s|$)/i);
  if (!ingSectionMatch) return null;

  const ingredientBlock = ingSectionMatch[1];
  const ingredients = [];
  const lines = ingredientBlock.split('\n');
  for (let line of lines) {
    line = line.trim();
    const itemMatch = line.match(/^[-*]\s+(.+)$/);
    if (itemMatch) {
      let text = itemMatch[1].trim();
      text = text.replace(/\s{2,}/g, ' ');  // collapse multiple spaces
      text = text.replace(/\*\*/g, '');       // strip bold markers
      text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // strip markdown links
      if (text.length > 1 && text.length < 200 && !text.match(/^(for the|for )\b/i)) {
        ingredients.push(text);
      }
    }
  }

  return ingredients.length > 0 ? { title, ingredients } : null;
}

// Fallback: extract from common HTML recipe markup
function extractFromHtml(doc) {
  // Try common recipe plugins (WPRM, Tasty, etc.)
  const selectors = [
    '.wprm-recipe-ingredient',
    '.tasty-recipe-ingredients li',
    '.tasty-recipes-ingredients li',
    '.recipe-ingredients li',
    '.ingredient-list li',
    '.ingredients-list li',
    '.ingredients li',
    '[itemprop="recipeIngredient"]',
    '[itemprop="ingredients"]',
    '.recipe__ingredient',
    '.o-Ingredients__a-Ingredient',
    '.mv-create-ingredients li',
    '.recipe-card-ingredients li',
    '.wpurp-recipe-ingredient',
    '.ingredient',
    'li.ingredient',
    '.recipe-ingred_txt',
    '.structured-ingredients__list-item',
  ];

  let ingredients = [];
  for (const sel of selectors) {
    const els = doc.querySelectorAll(sel);
    if (els.length > 0) {
      els.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 1 && text.length < 200) {
          ingredients.push(text);
        }
      });
      if (ingredients.length > 0) break;
    }
  }

  // Get title
  let title = '';
  const titleSels = [
    '.wprm-recipe-name',
    '.tasty-recipe-title',
    '.recipe-title',
    '[itemprop="name"]',
    'h1', 'h2'
  ];
  for (const sel of titleSels) {
    const el = doc.querySelector(sel);
    if (el && el.textContent.trim().length > 2) {
      title = el.textContent.trim();
      break;
    }
  }

  return ingredients.length > 0 ? { title, ingredients } : null;
}

// Parse a raw ingredient string like "2 tablespoons olive oil" into { name, qty }
// Decode HTML entities that leak through from recipe JSON-LD/HTML ("&nbsp;", "&amp;", "&#189;" ...)
function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1 && str.indexOf('\u00a0') === -1) return str || '';
  const map = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
                '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾', '&#189;': '½', '&#188;': '¼', '&#190;': '¾',
                '&#8531;': '⅓', '&#8532;': '⅔', '&#8539;': '⅛', '&#8540;': '⅜', '&#8541;': '⅝', '&#8542;': '⅞',
                '&deg;': '°', '&ndash;': '-', '&mdash;': '-', '&#8211;': '-', '&#8212;': '-' };
  str = str.replace(/&[a-z]+;|&#\d+;/gi, m => map[m.toLowerCase()] !== undefined ? map[m.toLowerCase()] : m);
  // Any remaining numeric entities
  str = str.replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code, 10)));
  return str.replace(/\u00a0/g, ' ');
}

function parseIngredientString(raw) {
  raw = decodeEntities(raw).trim()
    .replace(/▢\s*/g, '')  // WPRM checkbox chars
    .replace(/\s+/g, ' ');

  if (!raw) return { name: '', qty: '' };

  // Unicode fractions → ascii
  const unicodeFracs = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
  for (const [sym, frac] of Object.entries(unicodeFracs)) {
    raw = raw.replace(new RegExp(sym, 'g'), frac);
  }

  // Normalize dashes in numbers: "1-1/2" → "1 1/2"
  raw = raw.replace(/(\d)-(\d)/, '$1 $2');

  // Strip "Optional:", "Optional toppings:", "Optional ingredients:", "For the topping:", etc.
  raw = raw.replace(/^(?:optional|for the|for)\s*(?:toppings?|ingredients?|garnish(?:es)?|topping|serving|the sauce|the salad|the dressing)?[:\s]*/i, '').trim();

  // Strip "(optional)" anywhere
  raw = raw.replace(/\(optional\)/gi, '').trim();

  // Before stripping parens, try to extract a useful weight/measure from them
  // e.g. "2 chicken breasts (1 1/2 to 2 pounds total)" → prefer "2 lb"
  // e.g. "sun-dried tomatoes (2 1/2 ounces)" → "2 1/2 oz"
  let parenWeight = '';
  const parenWeightMatch = raw.match(/\(([^)]*?(\d[\d\s/.]*)\s*(pounds?|lbs?|lb|ounces?|oz|grams?|g|kg)[^)]*)\)/i);
  if (parenWeightMatch) {
    // Extract the LAST number before the unit (handles "1 1/2 to 2 pounds" → 2)
    const inner = parenWeightMatch[1];
    const rangeInParen = inner.match(/([\d\s/.]+)\s+to\s+([\d\s/.]+)\s*(pounds?|lbs?|lb|ounces?|oz|grams?|g|kg)/i);
    if (rangeInParen) {
      parenWeight = `${rangeInParen[2].trim()} ${normalizeUnit(rangeInParen[3])}`;
    } else {
      const singleInParen = inner.match(/([\d\s/.]+)\s*(pounds?|lbs?|lb|ounces?|oz|grams?|g|kg)/i);
      if (singleInParen) {
        parenWeight = `${singleInParen[1].trim()} ${normalizeUnit(singleInParen[2])}`;
      }
    }
  }

  // Remove ALL parentheses and their contents
  raw = raw.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\)\s*/g, ' ').replace(/\s*\(\s*/g, ' ').trim();

  // If we found a weight in parens and the main part is just "N item(s)", use the weight
  if (parenWeight) {
    const countOnly = raw.match(/^(\d+)\s+(.+)$/);
    if (countOnly) {
      const name = cleanIngName(countOnly[2]);
      // Only use paren weight if the main qty has no unit of its own
      const mainHasUnit = extractUnit(countOnly[2]);
      if (!mainHasUnit && name) {
        return { name, qty: parenWeight };
      }
    }
  }

  // Handle "Juice and zest of 2 limes" → name: "limes", qty: "2"
  const juiceZestMatch = raw.match(/^(?:juice|zest|juice and zest|zest and juice)\s+of\s+([\d\s/.]+)\s+(.+)$/i);
  if (juiceZestMatch) {
    return { name: cleanIngName(juiceZestMatch[2]), qty: juiceZestMatch[1].trim() };
  }

  // Handle "N to M items" pattern: "6 to 8 ears of corn" → name: "corn", qty: "6-8"
  const rangeMatch = raw.match(/^([\d/.]+)\s+to\s+([\d/.]+)\s+(.+)$/i);
  if (rangeMatch) {
    const qty = `${rangeMatch[1]}-${rangeMatch[2]}`;
    let name = rangeMatch[3].replace(/^ears?\s+of\s+/i, ''); // "ears of corn" → "corn"
    return { name: cleanIngName(name), qty };
  }

  // Number pattern: handles "2", "1/2", "1 1/2", ".5"
  const numPat = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+\\.?\\d*)';

  // Unit words
  const unitWords = [
    'cups?', 'tablespoons?', 'teaspoons?', 'tbsp', 'tbs', 'tb', 'tsp', 'ts',
    'ounces?', 'oz', 'pounds?', 'lbs?', 'lb',
    'grams?', 'g', 'kg', 'kilograms?',
    'milliliters?', 'ml', 'liters?', 'l',
    'pints?', 'pt', 'quarts?', 'qt', 'gallons?', 'gal',
    'fl\\.?\\s*oz', 'fluid\\s+ounces?',
    'cloves?', 'cans?', 'bunch(?:es)?',
    'pinch(?:es)?', 'dash(?:es)?',
    'sprigs?', 'slices?', 'pieces?', 'heads?', 'stalks?', 'sticks?',
    'packages?', 'pkg', 'bags?', 'containers?', 'bottles?', 'jars?', 'boxes?',
    'ears?', 'envelopes?',
    'c',  // "c." = cup (Delish, Food Network, etc.) — keep last so longer units win
  ].join('|');

  // Pattern 1: number + unit + name  (e.g. "2 tablespoons olive oil")
  const p1 = new RegExp(`^(${numPat})\\s+(${unitWords})\\.?\\s+(.+)$`, 'i');
  const m1 = raw.match(p1);
  if (m1) {
    const qty = m1[1].trim();
    const unit = normalizeUnit(m1[2].trim());
    let name = cleanIngName(m1[3]);
    return { name, qty: `${qty} ${unit}` };
  }

  // Pattern 2: number + name (no unit, e.g. "3 eggs", "1/2 medium red pepper")
  const p2 = new RegExp(`^(${numPat})\\s+(.+)$`);
  const m2 = raw.match(p2);
  if (m2) {
    const qty = m2[1].trim();
    let name = m2[2];
    // Check if the next word is a unit we missed
    const unitCheck = new RegExp(`^(${unitWords})\\.?\\s+(.+)$`, 'i');
    const uc = name.match(unitCheck);
    if (uc) {
      const unit = normalizeUnit(uc[1].trim());
      name = cleanIngName(uc[2]);
      return { name, qty: `${qty} ${unit}` };
    }
    name = cleanIngName(name);
    return { name, qty };
  }

  // Pattern 3: no number at all
  return { name: cleanIngName(raw), qty: '' };
}

// Clean an ingredient name: strip prep words, size words, notes, simplify cuts
function cleanIngName(n) {
  // Remove parentheses first
  n = n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[()]/g, '').trim();

  // Collapse "X or Y" ingredient alternatives to just the first option.
  // e.g. "chicken breasts or thighs" → "chicken breasts", "butter or olive oil" → "butter".
  // For "red or orange bell pepper" this yields "red" but the synonym table maps all
  // bell-pepper variants together downstream, so the final result is still correct.
  n = n.replace(/\s+or\s+.*$/i, '').trim();

  // Only remove text after a comma if that text is a prep instruction,
  // NOT if it continues the ingredient name (e.g. "boneless, skinless chicken breasts").
  // Prep clauses start with participles/phrases like "diced", "cut into", "to taste", etc.
  const prepClause = /,\s*(cut |diced|chopped|sliced|minced|crushed|grated|shredded|melted|softened|divided|separated|drained|rinsed|trimmed|peeled|seeded|deveined|pitted|cored|cubed|julienned|beaten|whisked|sifted|packed|to taste|for |plus |or |at room|room temp|thawed|warmed|cooled|halved|quartered|crumbled|torn|pressed|squeezed|patted|rinsed|well |finely|coarsely|roughly|thinly|thickly|optional|as needed|if |about ).*$/i;
  n = n.replace(prepClause, '').trim();

  // Normalize commas between descriptor words: "boneless, skinless" → "boneless skinless"
  n = n.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // Strip leading PREP / SIZE / STATE descriptors (repeated to catch stacked modifiers).
  // Product-defining words are intentionally KEPT because they change what you buy:
  //   colors (red, green, yellow), low-sodium, unsweetened/sweetened, unsalted/salted,
  //   smoked, light/dark (brown sugar), frozen, canned, dried, whole, plain, sweet (potato), hot (sauce)
  const stripWords = /^(fresh|freshly|minced|chopped|diced|sliced|crushed|grated|shredded|large|small|medium|med|thin|thick|finely|coarsely|roughly|thinly|thickly|boneless|skinless|bone-in|skin-on|organic|raw|cooked|extra-virgin|extra virgin|all-purpose|all purpose|flat-leaf|flat leaf|ripe|firm|soft|warm|cold|packed|loosely|tightly|peeled|trimmed|seeded|deveined|pitted|cored|cubed|julienned|melted|softened|room temperature|divided|separated|beaten|whisked|sifted|drained|rinsed|soaked|crispy|crisp|tender|lean|thick-cut|thin-cut|head of|heads of|broken|crumbled|squeezed|freshly squeezed|nacho-flavored|flavored|prepared|leftover|good-quality|good quality|high-quality|quality|store-bought|homemade)\s+/i;

  // "ground" is a prep word for spices ("ground cumin" → "cumin") but part of the product
  // name for meat ("ground beef" stays "ground beef")
  n = n.replace(/^ground\s+(?!(?:beef|turkey|pork|chicken|lamb|sausage|meat|bison|veal|venison)\b)/i, '');

  let prev = '';
  while (prev !== n) {
    prev = n;
    n = n.replace(stripWords, '').trim();
    n = n.replace(/^ground\s+(?!(?:beef|turkey|pork|chicken|lamb|sausage|meat|bison|veal|venison)\b)/i, '');
  }

  // Simplify meat cuts: "chicken breast halves" → "chicken breast"
  n = n.replace(/\s+halves$/i, '');
  n = n.replace(/\s+half$/i, '');
  n = n.replace(/\s+filets?$/i, '');
  n = n.replace(/\s+fillets?$/i, '');
  n = n.replace(/\s+cutlets?$/i, '');

  // "ears of corn" → "corn"
  n = n.replace(/^ears?\s+of\s+/i, '');
  n = n.replace(/^to\s+\d+\s+/i, '');
  n = n.replace(/^ears?\s+of\s+/i, '');
  n = n.replace(/^of\s+/i, '');

  n = n.replace(/\s+/g, ' ').trim();
  if (n.length < 2) return '';
  return n;
}

// Items to exclude from the grocery list entirely
// Returns true if the "name" is actually just a measurement unit word (junk from bad parsing)
function isJustUnit(name) {
  const n = name.toLowerCase().trim().replace(/s$/, '');  // singularize
  const units = [
    'teaspoon', 'tablespoon', 'tbsp', 'tsp', 'cup', 'ounce', 'oz', 'pound', 'lb',
    'gram', 'g', 'kg', 'kilogram', 'milliliter', 'ml', 'liter', 'l',
    'pint', 'quart', 'gallon', 'clove', 'can', 'bunch', 'pinch', 'dash',
    'sprig', 'slice', 'piece', 'head', 'stalk', 'stick', 'package', 'bag',
    'container', 'bottle', 'jar', 'box', 'ear', 'envelope', 'fl oz', 'fluid ounce',
  ];
  return units.includes(n);
}

function shouldExcludeIngredient(name) {
  const n = name.toLowerCase().trim();
  const excludes = [
    /^water$/,
    /^warm water$/,
    /^hot water$/,
    /^cold water$/,
    /^ice water$/,
    /^boiling water$/,
    /^tap water$/,
    /^cooking spray$/,
    /^non-?stick spray$/,
    /^nonstick spray$/,
    /^salt and pepper$/,
    /^salt and pepper to taste$/,
    /^boneless$/,              // junk leftover from bad parse
    /^skinless$/,
    /^boneless skinless$/,
    /^to taste$/,
    /^$/,
  ];
  return excludes.some(re => re.test(n));
}

// Categorize an ingredient name locally (no AI)
function categorizeIngredient(name, qty) {
  const n = name.toLowerCase().trim();
  const q = (qty || '').toLowerCase();

  // Anything measured in cans or jars is a shelf-stable pantry item
  // ("1 can diced tomatoes", "1 jar roasted red peppers", "1 can coconut milk")
  if (/\b(cans?|jars?)\b/.test(q)) {
    return 'pantry';
  }
  // Frozen anything → frozen aisle (checked before produce so "frozen peas" doesn't land in produce)
  if (/\bfrozen\b/.test(n)) {
    return 'frozen';
  }
  // Shelf-stable "milks" are pantry, not dairy
  if (/\b(coconut|evaporated|condensed)\s+milk\b/.test(n) || /\bcoconut\s+cream\b/.test(n)) {
    return 'pantry';
  }

  // HIGH PRIORITY pantry overrides — these collide with produce/meat keywords otherwise.
  // "black pepper", "ground black pepper", "white pepper" → pantry (spice), not produce.
  if (/\b(black|white|ground|cracked|whole)\s+pepper(corns?)?\b/.test(n) || /\bpeppercorns?\b/.test(n)) {
    return 'pantry';
  }
  // "X powder/flakes/seasoning/salt/extract" where X is a produce/spice word → pantry
  if (/\b(powder|powdered|flakes?|granules?|granulated|seasoning|extract)\b/.test(n) &&
      /\b(onion|garlic|celery|chili|chile|chipotle|ginger|tomato|mushroom|herb|paprika|mustard|curry|chive|pepper)\b/.test(n)) {
    return 'pantry';
  }
  // Any phrase containing "dried" + a herb/spice (any word order) → pantry
  if (/\bdried\b/.test(n) &&
      /\b(oregano|basil|thyme|rosemary|sage|parsley|cilantro|dill|mint|tarragon|marjoram|bay|chili|chile|pepper|mustard|ginger|herbs?|cumin|coriander)\b/.test(n)) {
    return 'pantry';
  }
  // Broth / stock / bouillon → pantry even though they contain meat words
  if (/\b(broth|stock|bouillon|consomm)\b/.test(n)) {
    return 'pantry';
  }
  // Bottled/canned juices → beverages ("pineapple juice", "orange juice", "apple juice").
  // Lemon/lime juice stays produce since you buy the fruit.
  if (/\bjuice\b/.test(n) && !/\b(lemon|lime|citrus)\b/.test(n)) {
    return 'beverages';
  }
  // Roasts and other beef/pork cuts that don't contain an explicit meat keyword
  if (/\b(chuck|brisket|sirloin|tenderloin|round|rump|flank|skirt|ribeye|rib-eye|loin)\b.*\broast\b/.test(n) ||
      /\b(roast)\b.*\b(beef|pork|chuck|round)\b/.test(n) ||
      /\bchuck\b/.test(n)) {
    return 'meat';
  }

  const rules = [
    // Meat & Seafood
    [/\b(chicken|beef|pork|steak|lamb|turkey|duck|bacon|sausage|ham|prosciutto|salami|pepperoni|veal|brisket|ribs?|salmon|tuna|shrimp|prawns?|crab|lobster|fish|cod|tilapia|halibut|scallops?|mussels?|clams?|oysters?|anchovies?|sardines?|calamari|squid|mahi|swordfish|trout|sea bass|ground meat|meatballs?|hot dogs?)\b/, 'meat'],
    // Dairy & Eggs
    [/\b(milk|cream|cheese|butter|yogurt|sour cream|cream cheese|cheddar|mozzarella|parmesan|parmigiano|ricotta|feta|gouda|brie|gruyere|provolone|swiss|goat cheese|cottage cheese|eggs?|half.and.half|whipping cream|heavy cream|buttermilk|ghee|crème|mascarpone)\b/, 'dairy'],
    // Produce
    [/\b(lettuce|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrot|celery|onion|garlic|ginger|tomato|pepper|bell pepper|jalapeño|jalapeno|chili|chile|potato|sweet potato|yam|corn|peas?|beans?|zucchini|squash|cucumber|avocado|mushroom|eggplant|artichoke|asparagus|beet|radish|turnip|leek|shallot|scallion|green onion|spring onion|lemon|lime|orange|apple|banana|(?:straw|blue|rasp|black|cran|goose|elder|boysen)?berr(?:y|ies)|grape|mango|pineapple|peach|pear|plum|melon|watermelon|coconut|cranberr(?:y|ies)|cherry|cherries|fig|kiwi|papaya|pomegranate|grapefruit|herb|basil|cilantro|parsley|mint|dill|rosemary|thyme|sage|oregano|chives?|tarragon|bay lea|lemongrass|fennel|endive|chard|bok choy|sprouts?|watercress|rhubarb|plantain|jicama|tomatillo)\b/, 'produce'],
    // Bakery
    [/\b(bread|tortillas?|pita|naan|baguettes?|croissants?|rolls?|buns?|bagels?|muffins?|english muffins?|flatbreads?|ciabatta|sourdough|wraps?|croutons?|breadcrumbs?|panko|hoagies?|sub rolls?|brioche|focaccia|dinner rolls?)\b/, 'bakery'],
    // Frozen
    [/\b(frozen|ice cream|popsicle|freezer|frost)\b/, 'frozen'],
    // Beverages
    [/\b(coffee|tea|juice|soda|water|wine|beer|ale|lager|spirits?|vodka|rum|whiskey|bourbon|tequila|gin|brandy|champagne|prosecco|cider|kombucha|smoothie|lemonade|drink)\b/, 'beverages'],
    // Snacks
    [/\b(chips?|crackers?|nuts?|almond|walnut|pecan|cashew|peanut|pistachio|macadamia|hazelnut|granola|trail mix|popcorn|pretzel|cookie|candy|chocolate bar|jerky|dried fruit|fruit snack|rice cake|seed|sunflower|pumpkin seed)\b/, 'snacks'],
    // Household
    [/\b(paper towel|toilet paper|napkin|dish soap|detergent|sponge|trash bag|foil|plastic wrap|parchment|wax paper|ziplock|sandwich bag|bleach|cleaner|disinfectant|hand soap)\b/, 'household'],
    // Pantry (default catch-all but with specific matches first)
    [/\b(oil|olive oil|vegetable oil|canola oil|sesame oil|coconut oil|vinegar|balsamic|soy sauce|tamari|fish sauce|worcestershire|hot sauce|sriracha|ketchup|mustard|mayo|mayonnaise|salsa|tomato paste|tomato sauce|marinara|pasta sauce|bbq sauce|teriyaki|hoisin|oyster sauce|mirin|rice vinegar|flour|sugar|brown sugar|powdered sugar|confectioner|honey|maple syrup|agave|molasses|corn syrup|cornstarch|baking soda|baking powder|yeast|vanilla|extract|salt|pepper|paprika|cumin|cinnamon|nutmeg|turmeric|cayenne|chili powder|garlic powder|onion powder|italian seasoning|oregano dried|basil dried|bay leaves|red pepper flakes|curry|garam masala|coriander|allspice|cloves|cardamom|saffron|sesame|poppy|celery seed|dill weed|everything bagel|taco seasoning|ranch seasoning|old bay|pasta|spaghetti|penne|fettuccine|linguine|macaroni|rice|quinoa|couscous|lentil|chickpea|black bean|kidney bean|pinto bean|white bean|canned tomato|diced tomato|crushed tomato|tomato|broth|stock|chicken broth|beef broth|vegetable broth|bouillon|coconut milk|evaporated milk|condensed milk|peanut butter|almond butter|jam|jelly|preserves|syrup|oat|oatmeal|cereal|granola|cracker|bread crumb|panko|tortilla chip|taco shell|noodle|ramen|udon|soba|rice noodle|wonton|dumpling|phyllo|puff pastry|pie crust|gelatin|cocoa|chocolate|chocolate chip|marshmallow|sprinkle|food coloring|anchovy paste|capers|olives?|pickle|relish|dried cranberr|raisin|dried apricot|date|prune|chia|flax|hemp|protein powder|nutritional yeast)\b/, 'pantry'],
  ];

  // Also test a crudely singularized copy so plurals match ("onions", "tomatoes", "berries")
  const singular = n
    .replace(/\b(\w+?)ies\b/g, '$1y')
    .replace(/\b(\w+?)(oes|ches|shes|xes|sses)\b/g, (m, stem, end) => stem + end.slice(0, -2))
    .replace(/\b(\w{3,}?)s\b/g, '$1');

  for (const [regex, cat] of rules) {
    if (regex.test(n) || regex.test(singular)) return cat;
  }

  return 'pantry';  // default
}

// Normalize an ingredient name to a base form for matching
function normalizeIngredientName(name) {
  let n = name.toLowerCase().trim();

  // Remove common preparation/form modifiers (multiple passes)
  const modifiers = [
    'fresh ', 'freshly ', 'dried ', 'ground ', 'minced ', 'chopped ', 'diced ',
    'sliced ', 'crushed ', 'grated ', 'shredded ', 'whole ', 'large ', 'small ',
    'medium ', 'fine ', 'finely ', 'coarsely ', 'roughly ', 'thinly ',
    'boneless ', 'skinless ', 'bone-in ', 'skin-on ',
    'organic ', 'raw ', 'cooked ', 'roasted ', 'toasted ',
    'unsalted ', 'salted ', 'sweetened ', 'unsweetened ',
    'extra-virgin ', 'extra virgin ', 'light ', 'dark ',
    'low-sodium ', 'low sodium ', 'reduced-sodium ', 'reduced sodium ',
    'all-purpose ', 'all purpose ',
    'broken ', 'crumbled ', 'squeezed ', 'freshly squeezed ',
    'nacho-flavored ', 'flavored ', 'plain ', 'sweet ',
    'ripe ', 'firm ', 'soft ', 'warm ', 'hot ', 'cold ',
    'packed ', 'loosely ', 'tightly ', 'dry ',
  ];
  for (let i = 0; i < 3; i++) {
    modifiers.forEach(mod => { n = n.replace(new RegExp('^' + mod.replace('-', '\\-'), 'i'), ''); });
  }
  n = n.trim();

  // Strip trailing descriptors in parens
  n = n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[()]/g, '').trim();

  // Remove notes after comma
  n = n.replace(/,\s*.*$/, '').trim();

  // Handle "juice of N lime" → "lime juice"
  n = n.replace(/^juice\s+of\s+\d+\s+/i, '');
  n = n.replace(/^juice\s+and\s+zest\s+of\s+\d+\s+/i, '');
  n = n.replace(/^zest\s+and\s+juice\s+of\s+\d+\s+/i, '');
  n = n.replace(/^zest\s+of\s+\d+\s+/i, '');

  // Simplify meat
  n = n.replace(/\s+halves$/i, '');
  n = n.replace(/\s+half$/i, '');
  n = n.replace(/\s+filets?$/i, '');
  n = n.replace(/\s+fillets?$/i, '');
  n = n.replace(/\s+cutlets?$/i, '');

  // Strip leftover patterns
  n = n.replace(/^to\s+\d+\s+/i, '');
  n = n.replace(/^ears?\s+of\s+/i, '');
  n = n.replace(/^of\s+/i, '');

  // Normalize common ingredient synonyms/variants
  const synonyms = [
    [['garlic cloves', 'garlic clove', 'cloves garlic', 'clove garlic', 'cloves of garlic', 'clove of garlic', 'garlic'], 'garlic'],
    [['green onions', 'green onion', 'scallions', 'scallion', 'spring onions', 'spring onion'], 'green onion'],
    [['bell pepper', 'bell peppers', 'green bell pepper', 'green bell peppers', 'red bell pepper', 'red bell peppers', 'orange bell pepper', 'orange bell peppers', 'yellow bell pepper', 'yellow bell peppers', 'red bell or orange bell peppers', 'red or orange bell peppers', 'green pepper', 'red pepper', 'sweet red pepper', 'sweet green pepper'], 'bell pepper'],
    [['black pepper', 'pepper', 'black peppercorns', 'peppercorns'], 'black pepper'],
    [['kosher salt', 'sea salt', 'table salt', 'fine salt', 'flaky salt', 'seasoned salt'], 'salt'],
    [['olive oil', 'evoo'], 'olive oil'],
    [['vegetable oil', 'canola oil', 'neutral oil'], 'vegetable oil'],
    [['soy sauce', 'tamari', 'shoyu', 'sodium soy sauce'], 'soy sauce'],
    [['lemon juice', 'juice of lemon', 'juice of a lemon', 'lemons juiced', 'lemon', 'lemons'], 'lemon juice'],
    [['lime juice', 'juice of lime', 'juice of a lime', 'limes juiced', 'lime', 'limes', 'freshly squeezed lime juice', 'juice of 1 lime', 'juice and zest of 2 limes', 'juice of 2 limes'], 'lime juice'],
    [['lime zest', 'zest of lime', 'zest of a lime', 'zest of 1 lime', 'zest of 2 limes'], 'lime zest'],
    [['parmesan cheese', 'parmigiano reggiano', 'parmigiano', 'parmesan'], 'parmesan'],
    [['heavy cream', 'heavy whipping cream', 'whipping cream'], 'heavy cream'],
    [['cilantro', 'fresh cilantro', 'coriander leaves'], 'cilantro'],
    [['parsley', 'fresh parsley', 'flat-leaf parsley', 'flat leaf parsley', 'italian parsley'], 'parsley'],
    [['ginger', 'fresh ginger', 'ginger root', 'gingerroot'], 'ginger'],
    [['jalapeno', 'jalapeño', 'jalapeno pepper', 'jalapeño pepper'], 'jalapeño'],
    [['red pepper flakes', 'crushed red pepper', 'red chili flakes', 'chili flakes'], 'red pepper flakes'],
    [['chicken breast', 'chicken breasts', 'chicken', 'chicken breast halves'], 'chicken breast'],
    [['chicken thigh', 'chicken thighs'], 'chicken thigh'],
    [['salmon fillet', 'salmon fillets', 'salmon'], 'salmon'],
    [['ground beef', 'beef', 'lean ground beef'], 'ground beef'],
    [['taco seasoning', 'taco seasoning mix', 'envelope taco seasoning', 'envelope reduced-sodium taco seasoning', 'envelope reduced sodium taco seasoning', 'packet taco seasoning', 'reduced-sodium taco seasoning', 'reduced sodium taco seasoning'], 'taco seasoning'],
    [['tortilla chips', 'nacho-flavored tortilla chips', 'corn tortilla chips'], 'tortilla chips'],
    [['corn', 'corn kernels', 'ears of corn', 'ear of corn', 'sweet corn', 'corn on the cob'], 'corn'],
    [['tomatoes', 'tomato', 'diced tomatoes'], 'tomatoes'],
    [['onion', 'onions', 'yellow onion', 'yellow onions', 'white onion', 'white onions', 'red onion', 'red onions'], 'onion'],
    [['flour tortillas', 'flour tortilla', 'tortillas', 'tortilla'], 'tortillas'],
    [['fettuccine pasta', 'fettuccine', 'fettucine', 'fettucine pasta'], 'fettuccine'],
  ];

  for (const [variants, canonical] of synonyms) {
    for (const v of variants) {
      if (n === v) { n = canonical; break; }
    }
  }

  // Remove trailing 's' for simple plurals (but not for words ending in 'ss' like 'glass')
  if (n.endsWith('s') && !n.endsWith('ss') && n.length > 3) {
    n = n.slice(0, -1);
  }

  return n.replace(/\s+/g, ' ').trim();
}

// Find the matching key in a merged dict, or return null
function findMergeKey(mergedCat, normalizedName) {
  for (const key of Object.keys(mergedCat)) {
    if (key === normalizedName) return key;
  }
  return null;
}

// Rebuild the grocery list from all active recipes, merging quantities for shared items
function rebuildGroceryList() {
  const globalMerged = {};

  recipes.forEach(recipe => {
    if (!recipe.active || !recipe.ingredients) return;
    const factor = recipeFactor(recipe);
    recipe.ingredients.forEach(ing => {
      const normKey = normalizeIngredientName(ing.name);
      if (!normKey) return;
      const qty = scaleQty(ing.qty || '', factor);

      if (globalMerged[normKey]) {
        globalMerged[normKey].parts.push(qty);
        globalMerged[normKey].categories.add(ing.category || 'pantry');
        if (ing.name.length < globalMerged[normKey].name.length) {
          globalMerged[normKey].name = ing.name;
        }
        if (!globalMerged[normKey].recipeIds.has(recipe.id)) {
          globalMerged[normKey].recipeIds.add(recipe.id);
          globalMerged[normKey].recipes.push({ title: recipe.title, url: recipe.url, id: recipe.id });
        }
      } else {
        globalMerged[normKey] = {
          name: ing.name,
          parts: [qty],
          categories: new Set([ing.category || 'pantry']),
          recipeIds: new Set([recipe.id]),
          recipes: [{ title: recipe.title, url: recipe.url, id: recipe.id }]
        };
      }
    });
  });

  const byCat = {};
  CATEGORIES.forEach(cat => { byCat[cat.id] = {}; });
  const validCats = CATEGORIES.map(c => c.id);

  for (const [normKey, data] of Object.entries(globalMerged)) {
    const catPriority = ['produce', 'meat', 'dairy', 'bakery', 'pantry', 'frozen', 'beverages', 'snacks', 'household'];
    let bestCat = 'pantry';
    for (const cp of catPriority) {
      if (data.categories.has(cp)) { bestCat = cp; break; }
    }
    // User taught the app where this item belongs
    const override = settings.categoryOverrides[normKey];
    if (override && validCats.includes(override)) bestCat = override;

    const combinedQty = smartMergeQuantities(data.parts, normKey);
    const displayName = settings.nameOverrides[normKey] || data.name;

    byCat[bestCat][normKey] = {
      name: displayName,
      qty: combinedQty,
      usedBy: data.recipes,
      normKey
    };
  }

  // Index existing recipe items across ALL categories so a moved item keeps its checked state
  const oldByNorm = {};
  CATEGORIES.forEach(cat => {
    (state[cat.id] || []).forEach(item => {
      if (item.source === 'recipe') oldByNorm[item.normKey || normalizeIngredientName(item.name)] = item;
    });
  });

  CATEGORIES.forEach(cat => {
    const oldItems = state[cat.id] || [];
    const newItems = [];

    Object.values(byCat[cat.id] || {}).forEach(m => {
      const existing = oldByNorm[m.normKey];
      const isStaple = settings.staples.includes(m.normKey);
      newItems.push({
        name: m.name,
        qty: m.qty,
        // Staples you always have get added pre-checked
        checked: existing ? existing.checked : isStaple,
        id: existing ? existing.id : uid(),
        source: 'recipe',
        usedBy: m.usedBy,
        normKey: m.normKey
      });
    });

    oldItems.forEach(item => {
      if (item.source !== 'recipe') {
        newItems.push(item);
      }
    });

    state[cat.id] = newItems;
  });

  saveState();
}

// Average weights for common unitless ingredients (in oz)
const AVG_WEIGHTS = {
  'chicken breast': 8,
  'chicken thigh': 5,
  'salmon': 6,
  'chicken': 8,
  'egg': 2,
  'lemon': 3,
  'lemon juice': 1.5,  // ~1.5 oz juice per lemon
  'lime': 2,
  'lime juice': 1,     // ~1 oz juice per lime
  'onion': 6,
  'red onion': 6,
  'potato': 6,
  'sweet potato': 6,
  'bell pepper': 6,
  'tomato': 5,
  'avocado': 6,
  'banana': 4,
  'apple': 6,
  'zucchini': 6,
  'carrot': 3,
  'mango': 10,
  'corn': 5,       // per ear
  'ground beef': 8,
  'beef': 8,
};

// Smart merge that converts unitless counts to weight when mixed with weight units
function smartMergeQuantities(parts, normKey) {
  // Clean all parts first
  const cleaned = parts.map(p => cleanQtyString(p)).filter(p => p);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return formatQtyString(cleaned[0]);

  // Parse all parts
  const parsed = cleaned.map(parseQty).filter(Boolean);
  parsed.forEach(p => { p.normUnit = normalizeUnit(p.unit); });

  // Check what types of units we have
  const hasWeight = parsed.some(p => getUnitGroup(p.normUnit) === 'weight');
  const hasVolume = parsed.some(p => getUnitGroup(p.normUnit) === 'volume');
  const hasUnitless = parsed.some(p => !p.normUnit && p.amount > 0);

  // If mixed weight + unitless and we have an average weight, convert everything to weight
  if (hasWeight && hasUnitless && AVG_WEIGHTS[normKey]) {
    const avgOz = AVG_WEIGHTS[normKey];
    const allAsWeight = parsed.map(p => {
      if (!p.normUnit && p.amount > 0) {
        return `${p.amount * avgOz} oz`;
      }
      return p.normUnit ? `${p.amount} ${p.unit}` : '';
    }).filter(Boolean);
    return mergeQuantities(allAsWeight);
  }

  // If only unitless counts, just sum them
  if (!hasWeight && !hasVolume && hasUnitless) {
    const total = parsed.reduce((sum, p) => sum + (p.normUnit ? 0 : p.amount), 0);
    // Check if there are also unit-ed parts
    const unitParts = parsed.filter(p => p.normUnit);
    if (unitParts.length > 0) {
      return mergeQuantities(cleaned);
    }
    return total > 0 ? formatAmount(total) : '';
  }

  return mergeQuantities(cleaned);
}

// Unit conversion tables (everything converts to a base unit per group)
const UNIT_GROUPS = {
  volume: {
    base: 'tsp',  // base unit in teaspoons
    units: {
      'tsp': 1,
      'tbsp': 3,
      'fl oz': 6,
      'cup': 48,
      'pint': 96,
      'quart': 192,
      'gallon': 768,
      'ml': 0.202884,
      'l': 202.884,
    }
  },
  weight: {
    base: 'oz',
    units: {
      'oz': 1,
      'lb': 16,
      'g': 0.035274,
      'kg': 35.274,
    }
  }
};

// Find which group a unit belongs to
function getUnitGroup(unit) {
  for (const [groupName, group] of Object.entries(UNIT_GROUPS)) {
    if (group.units[unit] !== undefined) return groupName;
  }
  return null;
}

// Convert amount from one unit to another within the same group
function convertUnit(amount, fromUnit, toUnit) {
  const group = Object.values(UNIT_GROUPS).find(g => g.units[fromUnit] !== undefined);
  if (!group || group.units[toUnit] === undefined) return null;
  const baseAmount = amount * group.units[fromUnit];
  return baseAmount / group.units[toUnit];
}

// Pick the best display unit for a given amount in base units
// Optimized for shopping (store-friendly amounts), not measuring
function bestDisplayUnit(baseAmount, groupName) {
  const group = UNIT_GROUPS[groupName];
  if (!group) return null;

  if (groupName === 'volume') {
    // >= 4 tbsp (¼ cup) → show in cups — easier to shop for
    if (baseAmount >= 12) return 'cup';    // 12 tsp = 4 tbsp = ¼ cup
    if (baseAmount >= 3) return 'tbsp';     // >= 1 tbsp
    return 'tsp';
  }

  if (groupName === 'weight') {
    // >= 8oz (½ lb) → show in lb
    if (baseAmount >= 8) return 'lb';
    return 'oz';
  }

  return null;
}

// Format a number nicely — use common fractions for cooking
function formatAmount(num) {
  if (num === 0) return '0';

  const whole = Math.floor(num);
  const frac = num - whole;

  // Common cooking fractions
  const fractions = [
    [0, ''], [1/8, '⅛'], [1/4, '¼'], [1/3, '⅓'], [3/8, '⅜'],
    [1/2, '½'], [5/8, '⅝'], [2/3, '⅔'], [3/4, '¾'], [7/8, '⅞'], [1, '']
  ];

  // Find closest fraction (within 0.05 tolerance)
  let bestFrac = '';
  let bestDiff = 1;
  for (const [val, sym] of fractions) {
    const diff = Math.abs(frac - val);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestFrac = sym;
    }
  }

  // If fraction rounds to 1, bump whole number
  if (bestFrac === '' && frac > 0.9) {
    return String(whole + 1);
  }

  if (whole === 0 && bestFrac) return bestFrac;
  if (bestFrac) return `${whole} ${bestFrac}`;
  if (whole > 0) return String(whole);

  // Fallback for weird numbers
  return parseFloat(num.toFixed(2)).toString();
}

// ============================================================
// PURCHASE QUANTITIES — convert "¾ cup ketchup" into "1 bottle"
// ============================================================
// Each entry: [regex on normalized name, pack]
//   pack.label  — what one package is called
//   pack.vol    — package size in teaspoons (for volume-measured needs)
//   pack.wt     — package size in ounces   (for weight-measured needs)
//   pack.count  — items per package        (for unitless counts)
//   pack.unit   — the count's unit, when it isn't bare ("clove")
//   pack.fixed  — always 1 package regardless of amount
const PACK_SIZES = [
  // ---- Dairy ----
  [/\b(heavy|whipping) cream\b/,            { label: 'pint',      vol: 96 }],
  [/\bhalf.and.half\b/,                     { label: 'pint',      vol: 96 }],
  [/\bsour cream\b/,                        { label: 'container', vol: 96 }],
  [/\bcream cheese\b/,                      { label: 'block',     wt: 8, vol: 48 }],
  [/\bcottage cheese|ricotta|mascarpone\b/, { label: 'container', wt: 15, vol: 90 }],
  [/\b(greek )?yogurt\b/,                   { label: 'container', vol: 96, wt: 32 }],
  [/\bbuttermilk\b/,                        { label: 'quart',     vol: 192 }],
  [/\bmilk\b/,                              { label: 'half gallon', vol: 384 }],
  [/\bbutter\b/,                            { label: 'lb',        vol: 96, wt: 16, count: 4, unit: 'stick' }],
  [/\beggs?\b/,                             { label: 'dozen',     count: 12 }],
  [/\b(parmesan|parmigiano|pecorino|romano)\b/, { label: 'wedge', vol: 48, wt: 8 }],
  [/\b(feta|goat cheese|blue cheese|gorgonzola)\b/, { label: 'container', vol: 48, wt: 6 }],
  [/\b(shredded|grated)?\s*(cheddar|mozzarella|monterey jack|pepper jack|colby|swiss|gouda|provolone|gruyere|cheese)\b/, { label: 'bag', vol: 96, wt: 8 }],

  // ---- Produce ----
  [/^garlic$|\bgarlic cloves?\b/,           { label: 'head',      count: 10, unit: 'clove' }],
  [/\bgreen onions?\b|\bscallions?\b/,      { label: 'bunch',     count: 6 }],
  [/\b(cilantro|parsley|basil|mint|dill|chives?|rosemary|thyme|sage|oregano|tarragon)\b/, { label: 'bunch', fixed: true }],
  [/\bginger\b/,                            { label: 'piece',     fixed: true }],
  [/\b(spinach|arugula|kale|spring mix|salad greens|lettuce)\b/, { label: 'bag', vol: 240, wt: 5 }],
  [/\bstrawberr/,                            { label: 'lb',        vol: 144, wt: 16 }],
  [/\b(blueberr|raspberr|blackberr)/,        { label: 'pint',      vol: 96, wt: 6 }],
  [/\b(cherry|grape) tomato/,                { label: 'pint',      vol: 96, wt: 10 }],
  [/\bmushrooms?\b/,                        { label: 'package',   vol: 144, wt: 8 }],
  [/\bcelery\b/,                            { label: 'bunch',     count: 8, unit: 'stalk', vol: 240 }],
  [/\bcarrots?\b/,                          { label: 'bag',       count: 8, vol: 240, wt: 16 }],
  [/\blemon/,                                { label: 'lemon',     vol: 9, count: 1 }],   // 1 lemon ≈ 3 tbsp juice
  [/\blime/,                                 { label: 'lime',      vol: 6, count: 1 }],   // 1 lime ≈ 2 tbsp juice
  [/\bcorn\b/,                              { label: 'ear',       count: 1, vol: 36 }],
  [/\bbroccoli|cauliflower\b/,              { label: 'head',      vol: 240, count: 1 }],

  // ---- Meat ----
  [/\bbacon\b/,                             { label: 'package',   count: 12, unit: 'slice', wt: 12 }],
  [/\b(sausage|bratwurst|italian sausage)\b/, { label: 'package', count: 5, unit: 'link', wt: 16 }],

  // ---- Bakery ----
  [/\b(tortillas?|pita|naan)\b/,            { label: 'package',   count: 8 }],
  [/\b(buns?|rolls?|bagels?)\b/,            { label: 'package',   count: 8 }],
  [/\bbread\b/,                             { label: 'loaf',      count: 20, unit: 'slice' }],

  // ---- Pantry with real sizes ----
  [/\b(chicken|beef|vegetable|bone) (broth|stock)\b/, { label: 'carton', vol: 192 }],
  [/\bflour\b/,                             { label: 'bag',       vol: 960, wt: 80 }],
  [/\b(brown|granulated|white|powdered|confectioner)?\s*sugar\b/, { label: 'bag', vol: 480, wt: 32 }],
  [/\brice\b/,                              { label: 'bag',       vol: 480, wt: 32 }],
  [/\b(pasta|spaghetti|penne|fettuccine|linguine|rigatoni|macaroni|noodles?|tortellini|orzo)\b/, { label: 'box', wt: 16, vol: 384 }],
  [/\b(rolled |old.fashioned |quick )?oats\b/, { label: 'container', vol: 720, wt: 42 }],
  [/\bpanko|bread ?crumbs\b/,               { label: 'container', vol: 192, wt: 8 }],
  [/\b(tomato|marinara|pasta|pizza) sauce\b/, { label: 'jar',     vol: 144, wt: 24 }],
  [/\bcoconut milk\b/,                      { label: 'can',       vol: 84, wt: 14 }],
  [/\bpeanut butter|almond butter\b/,       { label: 'jar',       vol: 144, wt: 16 }],
  [/\b(chocolate chips?)\b/,                { label: 'bag',       vol: 96, wt: 12 }],
  [/\b(walnuts?|pecans?|almonds?|cashews?|pine nuts?|peanuts?|pistachios?)\b/, { label: 'bag', vol: 96, wt: 8 }],
  [/\b(raisins?|dried cranberr(?:y|ies)|dried fruit)\b/, { label: 'bag', vol: 96, wt: 8 }],
  [/\btortilla chips\b/,                    { label: 'bag',       fixed: true }],
];

// Anything in these categories measured by volume (cups/tbsp/tsp) is bought as one container
const ONE_CONTAINER_CATS = ['pantry', 'beverages', 'household', 'snacks'];

function pluralLabel(label, n) {
  if (!label || n === 1) return label;
  if (/(lb|oz|dozen)$/.test(label)) return label;
  if (/(ch|sh|x|s)$/.test(label)) return label + 'es';
  return label + 's';
}

// Returns { buy, need } — buy is what to grab, need is the recipe amount (or '' when no conversion happened)
function purchaseQty(item, catId) {
  const need = item.qty || '';
  if (item.source !== 'recipe') return { buy: need, need: '' };

  const key = itemNormKey(item);
  const override = settings.purchaseOverrides && settings.purchaseOverrides[key];
  if (override) return { buy: override, need };
  if (!need) return { buy: '', need: '' };

  const p = parseQty(need);
  if (!p) return { buy: need, need: '' };
  const unit = normalizeUnit(p.unit);
  const group = getUnitGroup(unit);   // 'volume' | 'weight' | null
  const amt = p.amount;
  const tsp = group === 'volume' ? amt * UNIT_GROUPS.volume.units[unit] : null;
  const oz  = group === 'weight' ? amt * UNIT_GROUPS.weight.units[unit] : null;

  for (const [re, pack] of PACK_SIZES) {
    if (!re.test(key)) continue;
    let count = null;
    if (pack.fixed) count = 1;
    else if (tsp != null && pack.vol) count = tsp / pack.vol;
    else if (oz != null && pack.wt) count = oz / pack.wt;
    else if (!unit && pack.count) count = amt / pack.count;
    else if (unit && pack.unit && unit === pack.unit && pack.count) count = amt / pack.count;
    if (count == null) break;   // matched but the recipe unit doesn't map — fall through to defaults
    const n = Math.max(1, Math.ceil(count - 0.05));
    const label = pluralLabel(pack.label, n);
    return { buy: label ? `${n} ${label}` : String(n), need };
  }

  // Shelf-stable items measured by the spoon or cup → one jar/bottle/bag
  if (ONE_CONTAINER_CATS.includes(catId) && (group === 'volume' || (group === 'weight' && oz < 12))) {
    return { buy: '1', need };
  }

  // Already a purchasable amount (counts, weights, cans)
  return { buy: need, need: '' };
}

// Smart quantity merger with unit conversion
function mergeQuantities(parts) {
  const valid = parts.filter(p => p.trim());
  if (valid.length === 0) return '';
  if (valid.length === 1) return formatQtyString(valid[0]);

  const parsed = valid.map(parseQty).filter(Boolean);
  if (parsed.length === 0) return valid.join(' + ');

  // Normalize all units first
  parsed.forEach(p => { p.normUnit = normalizeUnit(p.unit); });

  // Group by unit group (volume, weight, or ungrouped)
  const volumeParts = [];
  const weightParts = [];
  const otherByUnit = {};
  const unparsed = [];

  parsed.forEach(p => {
    const group = getUnitGroup(p.normUnit);
    if (group === 'volume') {
      volumeParts.push(p);
    } else if (group === 'weight') {
      weightParts.push(p);
    } else if (p.normUnit) {
      if (!otherByUnit[p.normUnit]) otherByUnit[p.normUnit] = { amount: 0, unit: p.normUnit };
      otherByUnit[p.normUnit].amount += p.amount;
    } else if (p.amount) {
      if (!otherByUnit['_none']) otherByUnit['_none'] = { amount: 0, unit: '' };
      otherByUnit['_none'].amount += p.amount;
    } else {
      unparsed.push(p.raw);
    }
  });

  const results = [];

  // Merge volume units
  if (volumeParts.length > 0) {
    let totalTsp = 0;
    volumeParts.forEach(p => {
      totalTsp += p.amount * UNIT_GROUPS.volume.units[p.normUnit];
    });
    const displayUnit = bestDisplayUnit(totalTsp, 'volume');
    const displayAmount = totalTsp / UNIT_GROUPS.volume.units[displayUnit];
    results.push(`${formatAmount(displayAmount)} ${displayUnit}`);
  }

  // Merge weight units
  if (weightParts.length > 0) {
    let totalOz = 0;
    weightParts.forEach(p => {
      totalOz += p.amount * UNIT_GROUPS.weight.units[p.normUnit];
    });
    const displayUnit = bestDisplayUnit(totalOz, 'weight');
    const displayAmount = totalOz / UNIT_GROUPS.weight.units[displayUnit];
    results.push(`${formatAmount(displayAmount)} ${displayUnit}`);
  }

  // Other units — sum all unitless counts together
  let unitlessTotal = 0;
  const namedUnits = {};

  Object.entries(otherByUnit).forEach(([key, g]) => {
    if (key === '_none') {
      unitlessTotal += g.amount;
    } else {
      if (!namedUnits[g.unit]) namedUnits[g.unit] = 0;
      namedUnits[g.unit] += g.amount;
    }
  });

  // If we have both named units and unitless, try to combine
  // If there's already a volume or weight result, fold unitless into that or drop it
  if (results.length > 0 && unitlessTotal > 0) {
    // Already have a unit-based result; unitless counts are likely redundant
    // Only add if no other result exists
  } else if (unitlessTotal > 0) {
    const namedKeys = Object.keys(namedUnits);
    if (namedKeys.length > 0) {
      // Prefer the named unit over bare count
      namedKeys.forEach(u => {
        results.push(`${formatAmount(namedUnits[u])} ${u}`);
      });
    } else {
      results.push(formatAmount(unitlessTotal));
    }
  }

  // Add any named non-volume/non-weight units that aren't already covered
  if (unitlessTotal === 0) {
    Object.values(namedUnits).forEach((amt, i) => {
      const u = Object.keys(namedUnits)[i];
      results.push(`${formatAmount(amt)} ${u}`);
    });
  }

  // Return just the first result if multiple — prefer unit-based over unitless
  if (results.length === 0) return '';
  return results[0];
}

// Format a single qty string with normalized units
function formatQtyString(str) {
  str = cleanQtyString(str);
  const p = parseQty(str);
  if (!p) return str;
  const norm = normalizeUnit(p.unit);
  if (!norm) {
    if (p.amount === 0) return '';
    return formatAmount(p.amount);
  }
  return `${formatAmount(p.amount)} ${norm}`;
}

// Clean a qty string: strip prep words, descriptors, notes
function cleanQtyString(str) {
  if (!str) return '';
  str = str.trim();

  // Ranges ("6-8", "2 to 3", "1½–2") → use the upper bound so you never come up short
  str = str.replace(/^([\d\s/.¼½¾⅓⅔⅛⅜⅝⅞]+?)\s*(?:-|–|to)\s*([\d\s/.¼½¾⅓⅔⅛⅜⅝⅞]+)/i, '$2');

  // Handle "4 (6 oz each)" → "24 oz"
  const eachMatch = str.match(/^(\d+)\s*\(\s*([\d.]+)\s*(oz|lb|g|kg)\s*each\s*\)/i);
  if (eachMatch) {
    const count = parseInt(eachMatch[1]);
    const perUnit = parseFloat(eachMatch[2]);
    const unit = eachMatch[3];
    return `${count * perUnit} ${unit}`;
  }

  // Handle "4 (6-ounce) fillets" → "24 oz"
  const parenSizeMatch = str.match(/^(\d+)\s*\(\s*([\d.]+)[- ]*(ounce|oz|pound|lb)\s*\)\s*/i);
  if (parenSizeMatch) {
    const count = parseInt(parenSizeMatch[1]);
    const perUnit = parseFloat(parenSizeMatch[2]);
    const unit = normalizeUnit(parenSizeMatch[3]);
    return `${count * perUnit} ${unit}`;
  }

  // Remove parenthetical notes: "(about 2 lbs)" → keep the amount if useful
  const aboutMatch = str.match(/\(\s*about\s+([\d./]+\s*(?:lb|lbs|oz|g|kg|cup|cups))\s*\)/i);
  if (aboutMatch) {
    // Use the parenthetical amount instead
    str = aboutMatch[1];
    return str;
  }

  // Strip all parenthetical content
  str = str.replace(/\s*\(.*?\)\s*/g, ' ').trim();

  // Remove prep/descriptor words after the unit
  // Match: number + unit + junk  OR  number + junk
  const prepJunk = /[,;]\s*.*$/;  // everything after comma/semicolon
  str = str.replace(prepJunk, '').trim();

  // Strip trailing descriptor words that aren't units
  const trailingJunk = /\s+(to taste|divided|or more|or less|or to taste|plus more|as needed|for garnish|for serving|for topping|optional|approximately|about|roughly|packed|heaping|rounded|scant|generous|level|sifted|melted|softened|at room temperature|room temperature|cold|warm|hot|chilled|frozen|thawed|drained|rinsed|trimmed|peeled|minced|chopped|diced|sliced|thinly sliced|cubed|crushed|grated|shredded|julienned|cut into.*|torn|broken|crumbled|uncooked|cooked|fresh|dried|ground|large|medium|small|thin|thick|ripe|firm|boneless|skinless|each|total|approximately)$/i;

  let prev = '';
  while (prev !== str) {
    prev = str;
    str = str.replace(trailingJunk, '').trim();
  }

  return str;
}

function parseQty(str) {
  str = cleanQtyString(str);
  if (!str) return null;

  // Handle unicode fractions: ½, ¼, ¾, ⅓, ⅔, ⅛, ⅜, ⅝, ⅞
  const unicodeFracs = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.333, '⅔': 0.667, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
  for (const [sym, val] of Object.entries(unicodeFracs)) {
    const uniMatch = str.match(new RegExp(`^(\\d+)?\\s*${sym}\\s*(.*)$`));
    if (uniMatch) {
      const whole = uniMatch[1] ? parseInt(uniMatch[1]) : 0;
      let unit = (uniMatch[2] || '').trim();
      // Only keep the unit if it's a real unit word
      unit = extractUnit(unit);
      return { amount: whole + val, unit, raw: str };
    }
  }

  // Handle fractions like "1/2", "1 1/2"
  const fracMatch = str.match(/^(\d+)?\s*(\d+)\/(\d+)\s*(.*)?$/);
  if (fracMatch) {
    const whole = fracMatch[1] ? parseInt(fracMatch[1]) : 0;
    const num = parseInt(fracMatch[2]);
    const den = parseInt(fracMatch[3]);
    let unit = (fracMatch[4] || '').trim();
    unit = extractUnit(unit);
    return { amount: whole + num / den, unit, raw: str };
  }

  // Handle decimal or whole numbers
  const numMatch = str.match(/^([\d.]+)\s*(.*)?$/);
  if (numMatch) {
    const amount = parseFloat(numMatch[1]);
    let unit = (numMatch[2] || '').trim();
    unit = extractUnit(unit);
    return { amount, unit, raw: str };
  }

  return { amount: 0, unit: '', raw: str };
}

// Extract only a valid unit from the beginning of a string, ignore the rest
function extractUnit(str) {
  if (!str) return '';
  str = str.trim().toLowerCase();

  const unitPatterns = [
    'tablespoons?', 'teaspoons?', 'tbsp', 'tbs', 'tb', 'tsp', 'ts',
    'cups?', 'fl\\.?\\s*oz', 'fluid\\s+ounces?',
    'pints?', 'pt', 'quarts?', 'qt', 'gallons?', 'gal',
    'ounces?', 'oz', 'pounds?', 'lbs?', 'lb',
    'grams?', 'g', 'kg', 'kilograms?',
    'milliliters?', 'ml', 'liters?', 'l',
    'cloves?', 'cans?', 'bunch(?:es)?',
    'pinch(?:es)?', 'dash(?:es)?',
    'sprigs?', 'slices?', 'pieces?', 'heads?', 'stalks?', 'sticks?',
    'packages?', 'pkg', 'bags?', 'containers?', 'bottles?', 'jars?', 'boxes?',
    'ears?', 'envelopes?',
    'c',
  ];

  const pattern = new RegExp(`^(${unitPatterns.join('|')})\\.?(?:\\s|$)`, 'i');
  const match = str.match(pattern);
  if (match) return match[1];
  return '';  // No valid unit found — return empty, not the junk text
}

function normalizeUnit(unit) {
  if (!unit) return '';
  unit = unit.toLowerCase().trim().replace(/\.$/, '');
  const aliases = {
    'tbsp': 'tbsp', 'tablespoon': 'tbsp', 'tablespoons': 'tbsp', 'tbs': 'tbsp', 'tb': 'tbsp',
    'tsp': 'tsp', 'teaspoon': 'tsp', 'teaspoons': 'tsp', 'ts': 'tsp',
    'cup': 'cup', 'cups': 'cup', 'c': 'cup',
    'fl oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
    'pint': 'pint', 'pints': 'pint', 'pt': 'pint',
    'quart': 'quart', 'quarts': 'quart', 'qt': 'quart',
    'gallon': 'gallon', 'gallons': 'gallon', 'gal': 'gallon',
    'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
    'lb': 'lb', 'lbs': 'lb', 'pound': 'lb', 'pounds': 'lb',
    'g': 'g', 'gram': 'g', 'grams': 'g',
    'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
    'ml': 'ml', 'milliliter': 'ml', 'milliliters': 'ml',
    'l': 'l', 'liter': 'l', 'liters': 'l',
    'clove': 'clove', 'cloves': 'clove',
    'can': 'can', 'cans': 'can',
    'bunch': 'bunch', 'bunches': 'bunch',
    'pinch': 'pinch', 'pinches': 'pinch',
    'dash': 'dash', 'dashes': 'dash',
    'sprig': 'sprig', 'sprigs': 'sprig',
    'slice': 'slice', 'slices': 'slice',
    'piece': 'piece', 'pieces': 'piece',
    'head': 'head', 'heads': 'head',
    'stalk': 'stalk', 'stalks': 'stalk',
    'ear': 'ear', 'ears': 'ear',
    'envelope': 'envelope', 'envelopes': 'envelope',
    'package': 'package', 'packages': 'package', 'pkg': 'package',
  };
  return aliases[unit] || unit;
}

// Build a single item row (checkbox, name, qty, delete, recipe tags) for a given category
function buildItemRow(item, cat, container) {
  const row = document.createElement('div');
  row.className = 'item-row' + (item.checked ? ' checked' : '') + (item.usedBy && item.usedBy.length > 0 ? ' has-tags' : '');

  // Checkbox
  const label = document.createElement('label');
  label.className = 'checkbox-wrap';
  label.style.setProperty('--cat-color', cat.color);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = item.checked;
  const checkmark = document.createElement('div');
  checkmark.className = 'checkmark';
  checkmark.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="3.5 8 6.5 11.5 12.5 4.5"/></svg>';
  label.appendChild(cb);
  label.appendChild(checkmark);
  row.appendChild(label);

  // Item name
  const nameSpan = document.createElement('span');
  nameSpan.className = 'item-name';
  nameSpan.textContent = item.name;
  nameSpan.title = 'Tap to rename, move, or mark as staple';
  nameSpan.onclick = (e) => { e.stopPropagation(); openItemSheet(item, cat); };
  row.appendChild(nameSpan);

  // Qty input — shows the purchase quantity; the recipe amount goes in the fine print below
  const pq = purchaseQty(item, cat.id);
  const qtyInput = document.createElement('input');
  qtyInput.className = 'item-qty';
  qtyInput.type = 'text';
  qtyInput.inputMode = 'text';
  qtyInput.placeholder = 'qty';
  qtyInput.value = pq.buy;
  qtyInput.title = pq.need ? `Recipe needs ${pq.need}` : '';
  row.appendChild(qtyInput);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'item-delete';
  delBtn.setAttribute('aria-label', 'Delete');
  delBtn.textContent = '×';
  row.appendChild(delBtn);

  cb.onchange = (e) => {
    item.checked = e.target.checked;
    saveState();
    render();
  };
  qtyInput.onchange = (e) => {
    const v = e.target.value.trim();
    if (item.source === 'recipe') {
      // Recipe items are regenerated on every rebuild, so remember the edit as a purchase override
      const key = itemNormKey(item);
      if (!settings.purchaseOverrides) settings.purchaseOverrides = {};
      if (v) settings.purchaseOverrides[key] = v; else delete settings.purchaseOverrides[key];
      saveSettings();
      render();
    } else {
      item.qty = v;
      saveState();
    }
  };
  delBtn.onclick = () => {
    const arr = state[cat.id];
    const i = arr.indexOf(item);
    if (i !== -1) arr.splice(i, 1);
    saveState();
    render();
  };

  container.appendChild(row);

  // Recipe tags + "needs X" fine print
  if (item.usedBy && item.usedBy.length > 0) {
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'item-recipes';
    if (pq.need) {
      const needEl = document.createElement('p');
      needEl.className = 'item-need';
      needEl.textContent = `needs ${pq.need}`;
      tagsDiv.appendChild(needEl);
    }
    const summary = document.createElement('p');
    summary.className = 'recipe-summary';
    const count = item.usedBy.length;
    summary.textContent = `Used in ${count} recipe${count > 1 ? 's' : ''} ▸`;
    tagsDiv.appendChild(summary);
    const expanded = document.createElement('div');
    expanded.className = 'recipe-tags-expanded';
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'recipe-tags-wrap';
    item.usedBy.forEach(r => {
      const tag = document.createElement('a');
      tag.className = 'recipe-tag';
      tag.href = r.url;
      tag.target = '_blank';
      tag.rel = 'noopener';
      tag.textContent = r.title;
      tag.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.open(r.url, '_blank'); });
      tagsWrap.appendChild(tag);
    });
    expanded.appendChild(tagsWrap);
    const collapseLink = document.createElement('p');
    collapseLink.className = 'recipe-collapse';
    collapseLink.textContent = '▴ collapse';
    expanded.appendChild(collapseLink);
    tagsDiv.appendChild(expanded);
    summary.onclick = () => { summary.style.display = 'none'; expanded.classList.add('open'); };
    collapseLink.onclick = () => { expanded.classList.remove('open'); summary.style.display = ''; };
    container.appendChild(tagsDiv);
  }
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const cats = orderedCategories();
  const checkedBucket = [];  // collect all checked items for the bottom section

  cats.forEach((cat, catPos) => {
    const allItems = state[cat.id] || [];
    // When the setting is on, checked items move to a "Checked" section at the bottom
    let items = allItems;
    if (settings.sinkChecked) {
      items = allItems.filter(i => !i.checked);
      allItems.forEach(i => { if (i.checked) checkedBucket.push({ item: i, cat }); });
    }
    const checkedCount = allItems.filter(i => i.checked).length;
    const isCollapsed = collapsed[cat.id];

    const section = document.createElement('div');
    section.className = 'category';

    // Header
    const header = document.createElement('div');
    header.className = 'cat-header' + (isCollapsed ? ' collapsed' : '');
    header.style.background = `linear-gradient(135deg, ${cat.color}, ${adjustColor(cat.color, -20)})`;

    // Reorder buttons
    const reorder = document.createElement('div');
    reorder.className = 'cat-reorder';
    const upBtn = document.createElement('button');
    upBtn.className = 'cat-move';
    upBtn.innerHTML = '▲';
    upBtn.disabled = catPos === 0;
    upBtn.onclick = (e) => { e.stopPropagation(); moveCategory(cat.id, -1); };
    const downBtn = document.createElement('button');
    downBtn.className = 'cat-move';
    downBtn.innerHTML = '▼';
    downBtn.disabled = catPos === cats.length - 1;
    downBtn.onclick = (e) => { e.stopPropagation(); moveCategory(cat.id, 1); };
    reorder.appendChild(upBtn);
    reorder.appendChild(downBtn);

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;flex:1;';
    headerLeft.appendChild(reorder);
    const h2 = document.createElement('h2');
    h2.textContent = cat.name;
    headerLeft.appendChild(h2);

    const meta = document.createElement('div');
    meta.className = 'cat-meta';
    meta.innerHTML = `
      <span class="cat-count">${allItems.length > 0 ? checkedCount + '/' + allItems.length : ''}</span>
      <span class="cat-chevron">▾</span>
    `;

    header.appendChild(headerLeft);
    header.appendChild(meta);

    header.onclick = () => {
      collapsed[cat.id] = !collapsed[cat.id];
      render();
    };
    section.appendChild(header);

    // Items container
    const container = document.createElement('div');
    container.className = 'cat-items' + (isCollapsed ? ' hidden' : '');

    items.forEach((item) => {
      buildItemRow(item, cat, container);
    });

    // Add item row
    const addRow = document.createElement('div');
    addRow.className = 'add-row';

    const addIcon = document.createElement('div');
    addIcon.className = 'add-icon';
    addIcon.textContent = '+';
    addRow.appendChild(addIcon);

    const addInput = document.createElement('input');
    addInput.className = 'add-input';
    addInput.type = 'text';
    addInput.placeholder = 'Add item...';
    addInput.setAttribute('enterkeyhint', 'next');
    addRow.appendChild(addInput);

    const addQty = document.createElement('input');
    addQty.className = 'add-qty';
    addQty.type = 'text';
    addQty.inputMode = 'text';
    addQty.placeholder = 'qty';
    addQty.setAttribute('enterkeyhint', 'done');
    addRow.appendChild(addQty);

    function submitAdd() {
      if (addInput.value.trim()) {
        state[cat.id].push({ name: addInput.value.trim(), qty: addQty.value.trim(), checked: false, id: uid(), source: 'manual' });
        saveState();
        render();
        setTimeout(() => {
          const cats = document.querySelectorAll('.category');
          const catIdx = CATEGORIES.findIndex(c => c.id === cat.id);
          if (cats[catIdx]) {
            const inp = cats[catIdx].querySelector('.add-input');
            if (inp) inp.focus();
          }
        }, 50);
      }
    }

    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addQty.focus();
      }
    });

    addQty.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAdd();
      }
    });

    container.appendChild(addRow);
    section.appendChild(container);
    app.appendChild(section);
  });

  // "Checked" section at the very bottom — collects all checked items across categories
  if (settings.sinkChecked && checkedBucket.length > 0) {
    const section = document.createElement('div');
    section.className = 'category';

    const isCollapsed = collapsed['__checked__'];
    const header = document.createElement('div');
    header.className = 'cat-header checked-header' + (isCollapsed ? ' collapsed' : '');
    header.style.background = 'linear-gradient(135deg, #8A8D94, #6E7178)';

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;flex:1;';
    const h2 = document.createElement('h2');
    h2.textContent = '✓ In Cart';
    headerLeft.appendChild(h2);

    const meta = document.createElement('div');
    meta.className = 'cat-meta';
    meta.innerHTML = `<span class="cat-count">${checkedBucket.length}</span><span class="cat-chevron">▾</span>`;

    header.appendChild(headerLeft);
    header.appendChild(meta);
    header.onclick = () => { collapsed['__checked__'] = !collapsed['__checked__']; render(); };
    section.appendChild(header);

    const container = document.createElement('div');
    container.className = 'cat-items' + (isCollapsed ? ' hidden' : '');

    checkedBucket.forEach(entry => {
      buildItemRow(entry.item, entry.cat, container);
    });

    section.appendChild(container);
    app.appendChild(section);
  }

  updateProgress();
}

function updateProgress() {
  let total = 0, checked = 0;
  CATEGORIES.forEach(cat => {
    const items = state[cat.id] || [];
    const named = items.filter(i => i.name.trim());
    total += named.length;
    checked += named.filter(i => i.checked).length;
  });

  const pct = total > 0 ? (checked / total * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent =
    total === 0 ? 'No items yet' :
    checked === total ? `All done! ${total} items ✓` :
    `${checked} of ${total} items`;
}

function uncheckAll() {
  CATEGORIES.forEach(cat => {
    (state[cat.id] || []).forEach(item => item.checked = false);
  });
  saveState();
  render();
}

let allCollapsed = false;
function toggleCollapseAll() {
  allCollapsed = !allCollapsed;
  CATEGORIES.forEach(cat => {
    collapsed[cat.id] = allCollapsed;
  });
  recipesCollapsed = allCollapsed;
  render();
  renderRecipes();
}

// --- Settings menu ---
function toggleSettings() {
  const menu = document.getElementById('settingsMenu');
  const overlay = document.getElementById('settingsOverlay');
  const isOpen = menu.classList.contains('open');
  if (isOpen) {
    menu.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    menu.classList.add('open');
    overlay.classList.add('open');
    updateSettingsUI();
  }
}

function updateSettingsUI() {
  document.getElementById('sinkCheckedToggle').classList.toggle('on', settings.sinkChecked);
  document.getElementById('darkModeToggle').classList.toggle('on', settings.darkMode);
}

function toggleSinkChecked() {
  settings.sinkChecked = !settings.sinkChecked;
  saveSettings();
  updateSettingsUI();
  render();
}

function toggleDarkMode() {
  settings.darkMode = !settings.darkMode;
  saveSettings();
  document.body.classList.toggle('dark', settings.darkMode);
  updateSettingsUI();
}

function checkForUpdates() {
  const statusEl = document.getElementById('updateCheckStatus');
  statusEl.textContent = 'Checking…';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) { statusEl.textContent = 'N/A'; return; }
      reg.update().then(() => {
        setTimeout(() => {
          if (reg.waiting || reg.installing) {
            statusEl.textContent = 'Update found!';
            if (reg.waiting) showUpdateBanner(reg);
          } else {
            statusEl.textContent = 'Up to date';
            setTimeout(() => { statusEl.textContent = ''; }, 2500);
          }
        }, 1200);
      }).catch(() => { statusEl.textContent = 'Error'; });
    });
  } else {
    statusEl.textContent = 'N/A';
  }
}


// --- Item editor sheet (rename / move category / staple) ---
let sheetItem = null, sheetCat = null, sheetSelectedCat = null, sheetStaple = false;

function itemNormKey(item) {
  return item.normKey || normalizeIngredientName(item.name);
}

function openItemSheet(item, cat) {
  sheetItem = item; sheetCat = cat; sheetSelectedCat = cat.id;
  sheetStaple = settings.staples.includes(itemNormKey(item));
  document.getElementById('sheetName').value = item.name;

  const cats = document.getElementById('sheetCats');
  cats.innerHTML = '';
  CATEGORIES.forEach(c => {
    const b = document.createElement('button');
    b.className = 'sheet-cat' + (c.id === sheetSelectedCat ? ' selected' : '');
    b.style.setProperty('--cat-color', c.color);
    b.textContent = c.name;
    b.onclick = () => {
      sheetSelectedCat = c.id;
      cats.querySelectorAll('.sheet-cat').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
    };
    cats.appendChild(b);
  });

  document.getElementById('sheetStapleToggle').classList.toggle('on', sheetStaple);
  document.getElementById('itemSheetOverlay').classList.add('open');
  document.getElementById('itemSheet').classList.add('open');
}

function closeItemSheet() {
  document.getElementById('itemSheetOverlay').classList.remove('open');
  document.getElementById('itemSheet').classList.remove('open');
  sheetItem = null;
}

function toggleSheetStaple() {
  sheetStaple = !sheetStaple;
  document.getElementById('sheetStapleToggle').classList.toggle('on', sheetStaple);
}

function saveItemSheet() {
  if (!sheetItem) return;
  const item = sheetItem, fromCat = sheetCat;
  const key = itemNormKey(item);
  const newName = document.getElementById('sheetName').value.trim();

  // Rename — recipe items get a remembered override (they're regenerated on every rebuild)
  if (newName && newName !== item.name) {
    item.name = newName;
    if (item.source === 'recipe') settings.nameOverrides[key] = newName;
  }

  // Staple — remembered by normalized name
  const idx = settings.staples.indexOf(key);
  if (sheetStaple && idx === -1) settings.staples.push(key);
  if (!sheetStaple && idx !== -1) settings.staples.splice(idx, 1);

  // Move category — remembered so future recipes put it in the right place
  if (sheetSelectedCat && sheetSelectedCat !== fromCat.id) {
    const arr = state[fromCat.id];
    const i = arr.indexOf(item);
    if (i !== -1) arr.splice(i, 1);
    (state[sheetSelectedCat] = state[sheetSelectedCat] || []).push(item);
    settings.categoryOverrides[key] = sheetSelectedCat;
  }

  saveSettings();
  saveState();
  closeItemSheet();
  // Recipe items rebuild so overrides apply to merged quantities/tags too
  if (item.source === 'recipe') rebuildGroceryList();
  render();
}

// --- Share / copy list as text ---
function buildListText() {
  const lines = [];
  orderedCategories().forEach(cat => {
    const items = (state[cat.id] || []).filter(i => !i.checked);
    if (!items.length) return;
    lines.push(cat.name.toUpperCase());
    items.forEach(i => { const b = purchaseQty(i, cat.id).buy; lines.push(`- ${i.name}${b ? ' (' + b + ')' : ''}`); });
    lines.push('');
  });
  return lines.join('\n').trim();
}

async function shareList() {
  const text = buildListText();
  if (!text) { showToast('Nothing left to buy!'); return; }
  toggleSettings();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Grocery List', text });
      return;
    }
  } catch(e) { if (e && e.name === 'AbortError') return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('List copied to clipboard');
  } catch(e) {
    // Last resort: a temporary textarea
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('List copied to clipboard'); } catch(e2) { showToast('Could not copy'); }
    document.body.removeChild(ta);
  }
}

let toastTimer = null;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function showClearModal() {
  document.getElementById('clearModal').classList.add('active');
}

function hideClearModal() {
  document.getElementById('clearModal').classList.remove('active');
}

function clearAll() {
  CATEGORIES.forEach(cat => { state[cat.id] = []; });
  // Deactivate all recipes but keep them saved
  recipes.forEach(r => { r.active = false; });
  saveState();
  saveRecipes();
  hideClearModal();
  render();
  renderRecipes();
}

function adjustColor(hex, amount) {
  let r = parseInt(hex.slice(1,3), 16) + amount;
  let g = parseInt(hex.slice(3,5), 16) + amount;
  let b = parseInt(hex.slice(5,7), 16) + amount;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Close modal on overlay tap
document.getElementById('clearModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideClearModal();
});

// One-time migration: re-parse stored recipe ingredients through the new parser
function migrateRecipes() {
  const PARSER_VERSION = 10;  // bump this number when parser improves
  try {
    const currentVersion = parseInt(localStorage.getItem('parserVersion') || '0');
    if (currentVersion >= PARSER_VERSION) return;

    let changed = false;
    recipes.forEach(recipe => {
      if (!recipe.ingredients) return;
      recipe.ingredients = recipe.ingredients
        .map(ing => {
          let name = ing.name || '';
          let qty = ing.qty || '';

          // Strip Optional prefixes that survived previous migrations
          name = name.replace(/^(?:optional|for the|for)\s*(?:toppings?|ingredients?|garnish(?:es)?|topping|serving|the sauce|the salad|the dressing)?[:\s]*/i, '').trim();

          // If name contains "Juice of/and zest of N item", re-parse it
          const juiceMatch = name.match(/^(?:juice|zest|juice and zest|zest and juice)\s+of\s+(\d+)\s+(.+)$/i);
          if (juiceMatch) {
            qty = juiceMatch[1];
            name = juiceMatch[2];
          }

          // If qty is empty but name starts with a number, try to re-parse the whole thing
          if (!qty && name.match(/^\d/)) {
            const reparsed = parseIngredientString(name);
            name = reparsed.name;
            qty = reparsed.qty;
          }

          // Decode stray HTML entities ("&nbsp;") saved by older parsers
          name = decodeEntities(name).replace(/\s+/g, ' ').trim();

          // If the name starts with a unit that an older parser missed ("c. ketchup" with qty "3/4"),
          // re-parse qty + name together so the unit moves into the quantity
          if (qty && !extractUnit(qty.replace(/^[\d\s/.\-¼½¾⅓⅔⅛⅜⅝⅞]+/, '')) && extractUnit(name)) {
            const reparsed = parseIngredientString(`${qty} ${name}`);
            if (reparsed.name) { name = reparsed.name; qty = reparsed.qty; }
          }

          // Run through cleanIngName
          name = cleanIngName(name);

          // Re-format qty
          qty = qty ? formatQtyString(qty) : '';

          // Re-categorize
          const category = name ? categorizeIngredient(name, qty) : (ing.category || 'pantry');

          return { name, qty, category };
        })
        .filter(ing => ing.name && ing.name.length >= 2 && !shouldExcludeIngredient(ing.name) && !isJustUnit(ing.name));
      changed = true;
    });

    if (changed) {
      saveRecipes();
      if (recipes.some(r => r.active)) {
        rebuildGroceryList();
      }
    }

    localStorage.setItem('parserVersion', String(PARSER_VERSION));
  } catch(e) {
    console.error('Migration error:', e);
  }
}

// Startup — recover from IndexedDB if localStorage was cleared, then render
async function startup() {
  await openIDB();

  // Apply dark mode immediately to avoid a flash
  if (settings.darkMode) document.body.classList.add('dark');

  // Ask the browser to make storage persistent (never auto-evict our data)
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch(e) {}

  // Recovery: if localStorage is empty but IndexedDB has data, restore it
  try {
    const lsRecipes = localStorage.getItem('groceryRecipes');
    const lsState = localStorage.getItem('groceryList');

    if (!lsRecipes || lsRecipes === '[]') {
      const idbRecipes = await idbGet('groceryRecipes');
      if (idbRecipes) {
        const parsed = JSON.parse(idbRecipes);
        if (Array.isArray(parsed) && parsed.length > 0) {
          recipes = parsed;
          localStorage.setItem('groceryRecipes', idbRecipes);
        }
      }
    }

    if (!lsState) {
      const idbState = await idbGet('groceryList');
      if (idbState) {
        state = JSON.parse(idbState);
        localStorage.setItem('groceryList', idbState);
      }
    }

    if (!localStorage.getItem('grocerySettings')) {
      const idbSettings = await idbGet('grocerySettings');
      if (idbSettings) {
        localStorage.setItem('grocerySettings', idbSettings);
        settings = loadSettings();
        document.body.classList.toggle('dark', !!settings.darkMode);
      }
    }
  } catch(e) {}

  // Ensure current data is mirrored to IndexedDB
  idbSet('groceryRecipes', JSON.stringify(recipes));
  idbSet('groceryList', JSON.stringify(state));
  idbSet('grocerySettings', JSON.stringify(settings));

  migrateRecipes();

  // Display app version
  const versionEl = document.getElementById('appVersion');
  if (versionEl) versionEl.textContent = APP_VERSION;

  // Always rebuild if there are active recipes, to populate usedBy links
  if (recipes.some(r => r.active)) {
    rebuildGroceryList();
  }

  render();
  renderRecipes();
}

startup();

// Register service worker for PWA + handle update notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Check for updates periodically
    setInterval(() => reg.update(), 60 * 1000);

    // When a new service worker is waiting, show the update banner
    function notifyUpdate() {
      if (reg.waiting) showUpdateBanner(reg);
    }
    if (reg.waiting) notifyUpdate();
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(reg);
          }
        });
      }
    });
  }).catch(() => {});

  // Reload once the new worker takes control
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

function showUpdateBanner(reg) {
  if (document.getElementById('updateBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:300;background:linear-gradient(135deg,#2D6A2E,#1B4B1C);color:#fff;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 -2px 16px rgba(0,0,0,0.2);font-family:inherit;';
  banner.innerHTML = '<span style="font-size:14px;font-weight:500;">A new version is available</span>';
  const btn = document.createElement('button');
  btn.textContent = 'Update';
  btn.style.cssText = 'background:#fff;color:#2D6A2E;border:none;border-radius:10px;padding:8px 18px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;';
  btn.onclick = () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    btn.textContent = 'Updating…';
    btn.disabled = true;
  };
  banner.appendChild(btn);
  document.body.appendChild(banner);
}

/* PROTOTYPE — intentionally throwaway, dependency-free, and in-memory only.
   Three variants of the physical inventory workflow, switchable via ?variant=. */

const cards = {
  pikachu: { id: 'pikachu', name: 'Pikachu', detail: '151 · 025/165 · EN · Reverse Holo', icon: '⚡', tone: 'electric' },
  charizard: { id: 'charizard', name: 'リザードンex', detail: '黒炎の支配者 · 125/108 · JP · SAR', icon: '炎', tone: 'fire' },
  gardevoir: { id: 'gardevoir', name: 'Gardevoir ex', detail: 'Scarlet & Violet · 086/198 · EN · Double Rare', icon: '✦', tone: 'psychic' },
  energy: { id: 'energy', name: 'Basic Grass Energy', detail: 'Scarlet & Violet · 001 · EN · Standard', icon: '葉', tone: 'energy' },
};

const initialLocations = [
  { id: 'home', name: 'Home office', parent: null, type: 'location', holdings: {} },
  { id: 'shelf', name: 'Display shelf', parent: 'home', type: 'location', holdings: {} },
  { id: 'binder', name: 'Main binder', parent: 'shelf', type: 'location', holdings: { pikachu: 4, charizard: 1 } },
  { id: 'trade', name: 'Trade box', parent: 'shelf', type: 'location', holdings: { pikachu: 2, gardevoir: 3 } },
  { id: 'travel', name: 'Travel case', parent: 'home', type: 'location', holdings: { gardevoir: 1, energy: 12 } },
  { id: 'deck', name: 'Gardevoir League Deck', parent: 'home', type: 'deck', holdings: { pikachu: 2, charizard: 1, gardevoir: 3, energy: 8 } },
];

let locations = structuredClone(initialLocations);
let selectedLocation = 'shelf';
let selectedCard = 'pikachu';
let sourceLocation = 'binder';
let targetLocation = 'deck';
let lastTransfer = null;
let toastTimer;
let dView = 'locations';
let transferDrawer = null;
let conversionDialog = null;
let nextLocationId = 1;
let bulkRows = [
  { id: 1, from: 'binder', card: 'pikachu', quantity: 1, to: 'deck' },
  { id: 2, from: 'trade', card: 'gardevoir', quantity: 2, to: 'deck' },
];
let nextBulkRowId = 3;
let eSelection = {};
let eHandleSelections = {};
let eFanned = new Set();
let dragSelection = null;
let fPickerOpen = false;
let fTarget = 'deck';
let fUndo = null;
let fToast = null;
let fSelectionError = null;

const variantNames = { A: 'Location explorer', B: 'Collection ledger', C: 'Transfer workstation', D: 'Synthesized workflow', E: 'File browser + stacks', F: 'Selection is review' };
const validVariants = ['A', 'B', 'C', 'D', 'E', 'F'];

const loc = id => locations.find(item => item.id === id);
const children = id => locations.filter(item => item.parent === id);
const directCount = location => Object.values(location.holdings).reduce((a, b) => a + b, 0);
function descendants(id) { return children(id).flatMap(child => [child, ...descendants(child.id)]); }
function subtreeCount(location) { return directCount(location) + descendants(location.id).reduce((sum, child) => sum + directCount(child), 0); }
function cardAt(location, cardId) { return location.holdings[cardId] || 0; }
function cardInDescendants(location, cardId) { return descendants(location.id).reduce((sum, child) => sum + cardAt(child, cardId), 0); }
function cardTotal(cardId) { return locations.reduce((sum, location) => sum + cardAt(location, cardId), 0); }
function totalCards() { return Object.keys(cards).reduce((sum, id) => sum + cardTotal(id), 0); }
function pathFor(location) {
  const path = [location.name]; let current = location;
  while (current.parent) { current = loc(current.parent); path.unshift(current.name); }
  return path.join(' / ');
}

function cardArt(card, small = false) { return `<div class="card-art ${card.tone}${small ? ' small' : ''}">${card.icon}</div>`; }
function cardRows(location) {
  const entries = Object.entries(location.holdings).filter(([,qty]) => qty > 0);
  if (!entries.length) return '<div class="empty">No cards directly in this location.</div>';
  return entries.map(([id, qty]) => { const card = cards[id]; return `<div class="card-row">${cardArt(card)}<div><div class="card-name">${card.name}</div><div class="card-meta">${card.detail}</div></div><div class="qty">×${qty}</div></div>`; }).join('');
}
function locationOptions(selected, exclude) {
  return locations.filter(location => location.id !== exclude).map(location => `<option value="${location.id}" ${location.id === selected ? 'selected' : ''}>${location.type === 'deck' ? '◆ ' : ''}${pathFor(location)} (${directCount(location)})</option>`).join('');
}
function cardOptions(location, selected) {
  const entries = Object.entries(location.holdings).filter(([,qty]) => qty > 0);
  return entries.map(([id,qty]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${cards[id].name} — ${qty} available</option>`).join('');
}
function transferForm({ formClass = '', from = sourceLocation, to = targetLocation, card = selectedCard } = {}) {
  const source = loc(from) || locations[0];
  const availableCards = Object.entries(source.holdings).filter(([,qty]) => qty > 0);
  if (!availableCards.some(([id]) => id === card)) card = availableCards[0]?.[0];
  return `<form class="transfer-form ${formClass}" data-transfer-form>
    <div class="field"><label>Move from</label><select name="from" data-source>${locationOptions(source.id)}</select></div>
    <div class="field"><label>Card edition</label><select name="card">${cardOptions(source, card)}</select></div>
    <div class="transfer-arrow">↓ moves atomically ↓</div>
    <div class="field"><label>Move to</label><select name="to">${locationOptions(to, source.id)}</select></div>
    <div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" value="1" required></div>
    <button class="button" type="submit">Transfer cards</button>
    <div class="atomic-note"><strong>One operation:</strong> the source is reduced only if the destination can be increased. A failed move changes neither location.</div>
  </form>`;
}

function treeRows(parent = null, depth = 0) {
  return locations.filter(location => location.parent === parent).map(location => `<button class="tree-row indent-${Math.min(depth,2)} ${location.id === selectedLocation ? 'active' : ''}" data-location="${location.id}">
    <span><span class="tree-name">${location.type === 'deck' ? '◆' : depth ? '└' : '▾'} ${location.name}</span><span class="tree-meta">${location.type === 'deck' ? 'Deck · leaf location' : children(location.id).length + ' child locations'}</span></span>
    <span><strong>${directCount(location)}</strong><span class="tree-meta"> direct</span><br><strong>${subtreeCount(location)}</strong><span class="tree-meta"> total</span></span>
  </button>${treeRows(location.id, depth + 1)}`).join('');
}

function shell(content) {
  return `<div class="prototype-ribbon">Throwaway prototype · in-memory sample data · refresh resets everything</div>
    <header class="app-header"><div class="brand"><span class="brand-mark">T</span> Cardstead</div><div class="header-total">Collection <strong>${totalCards()} cards</strong> · ${Object.keys(cards).length} editions · ${locations.length} locations</div></header>
    <main class="page">${content}</main>${lastTransfer ? `<div class="toast" id="toast">✓ ${lastTransfer.quantity}× ${cards[lastTransfer.card].name}: ${loc(lastTransfer.from).name} → ${loc(lastTransfer.to).name}</div>` : ''}${switcher()}`;
}

function variantA() {
  const current = loc(selectedLocation);
  const descendant = subtreeCount(current) - directCount(current);
  return shell(`<section class="variant-a"><div class="a-intro"><p class="eyebrow">Variant A · Location first</p><h1>Where are your cards?</h1><p class="lede">Navigate your storage like a set of folders. Every location separates cards physically inside it from cards inside its children.</p></div>
    <div class="a-grid">
      <section class="panel"><div class="panel-head"><h2>Locations</h2><span class="pill">direct / total</span></div><div class="location-tree">${treeRows()}</div></section>
      <section class="panel"><div class="panel-head"><div><p class="eyebrow">${pathFor(current)}</p><h2>${current.name}</h2></div><span class="pill ${current.type === 'deck' ? 'deck' : ''}">${current.type === 'deck' ? '◆ Deck · leaf' : 'Location'}</span></div>
        <div class="summary-strip"><div class="summary-stat"><span>Directly here</span><strong>${directCount(current)}</strong></div><div class="summary-stat"><span>In descendants</span><strong>${descendant}</strong></div><div class="summary-stat"><span>Location total</span><strong>${subtreeCount(current)}</strong></div></div>
        ${current.type === 'deck' ? '<div class="leaf-explainer"><strong>This deck is a physical leaf Location.</strong><br>Cards moved here leave their old container, count toward this deck, and cannot be organized into child locations.</div>' : ''}
        <div class="panel-head"><h3>Cards directly here</h3><span class="pill direct">not descendants</span></div>${cardRows(current)}
      </section>
      <section class="panel"><div class="panel-head"><div><p class="eyebrow">Physical move</p><h2>Transfer</h2></div></div>${transferForm({ from: current.id, to: current.id === 'deck' ? 'binder' : 'deck' })}</section>
    </div></section>`);
}

function variantB() {
  const currentCard = cards[selectedCard];
  const distributions = locations.filter(location => cardAt(location, selectedCard) > 0);
  const deckQty = locations.filter(l => l.type === 'deck').reduce((sum,l) => sum + cardAt(l,selectedCard),0);
  return shell(`<section class="variant-b"><div class="b-hero"><p class="eyebrow">Variant B · Card first</p><h1>Your collection is the index.</h1><p class="lede">Start with what you own, then reveal where every physical copy lives. Locations are distribution details, not the primary navigation.</p></div>
    <div class="b-grid"><section class="panel"><div class="panel-head"><h2>Collection</h2><span class="pill">aggregate across all locations</span></div>
      ${Object.values(cards).map(card => { const total = cardTotal(card.id); const decks = locations.filter(l=>l.type==='deck').reduce((s,l)=>s+cardAt(l,card.id),0); return `<div class="collection-row ${card.id === selectedCard ? 'active' : ''}" data-card="${card.id}">${cardArt(card)}<div><div class="card-name">${card.name}</div><div class="card-meta">${card.detail}</div></div><div class="split-qty"><strong>${total}</strong><span>total owned</span></div><div class="split-qty descendants"><strong>${decks}</strong><span>in decks</span></div></div>`; }).join('')}
    </section><aside><section class="panel"><div class="panel-head"><div><p class="eyebrow">Distribution</p><h2>${currentCard.name}</h2></div><div class="qty">×${cardTotal(selectedCard)}</div></div><div class="distribution">${distributions.map(location=>`<div class="dist-row"><div><div class="dist-path">${pathFor(location)}</div><div class="dist-type">${location.type === 'deck' ? '◆ Deck · physical leaf Location' : `Location · ${cardInDescendants(location,selectedCard)} more in descendants`}</div></div><strong>×${cardAt(location,selectedCard)}</strong></div>`).join('')}</div></section>
      <section class="panel b-transfer"><div class="panel-head"><div><p class="eyebrow">Change distribution</p><h2>Move copies</h2></div></div>${transferForm({ card:selectedCard })}</section>
    </aside></div></section>`);
}

function pickList(location, role) {
  const entries = Object.entries(location.holdings).filter(([,qty])=>qty>0);
  if (!entries.length) return '<div class="empty">No cards directly here</div>';
  return entries.map(([id,qty])=>`<button class="pick-row ${role === 'source' && id === selectedCard ? 'active' : ''}" data-pick-card="${id}">${cardArt(cards[id],true)}<span><strong>${cards[id].name}</strong><br><span class="tiny muted">${cards[id].detail}</span></span><strong>×${qty}</strong></button>`).join('');
}
function variantC() {
  const source = loc(sourceLocation), target = loc(targetLocation);
  return shell(`<section class="variant-c"><div class="c-title"><div><p class="eyebrow">Variant C · Task first</p><h1>Transfer workstation</h1><p class="lede">Put two physical Locations side by side, choose copies, and confirm one atomic move.</p></div><span class="pill">Collection total: ${totalCards()} never changes during a move</span></div>
    <div class="c-grid"><section class="warehouse"><div class="warehouse-head"><strong>1 · Source Location</strong><select data-workspace-source>${locationOptions(source.id)}</select><p class="tiny muted">${directCount(source)} cards directly here · ${subtreeCount(source)-directCount(source)} in descendants</p></div><div class="warehouse-list">${pickList(source,'source')}</div></section>
      <form class="transfer-console" data-transfer-form><p class="eyebrow">2 · Atomic move</p><h2>${cards[selectedCard]?.name || 'Choose a card'}</h2><input type="hidden" name="from" value="${source.id}"><input type="hidden" name="card" value="${selectedCard}"><input type="hidden" name="to" value="${target.id}"><div class="transfer-path">${source.name}<br>↓<br>${target.name}</div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" value="1" required></div><button class="button" type="submit">Commit both changes</button><div class="atomic-note" style="margin-top:12px"><strong>All or nothing:</strong> subtract from source + add to destination. Insufficient copies leaves both untouched.</div></form>
      <section class="warehouse"><div class="warehouse-head"><strong>3 · Destination Location</strong><select data-workspace-target>${locationOptions(target.id,source.id)}</select><p class="tiny muted">${target.type === 'deck' ? '◆ Deck · physical leaf Location' : `${directCount(target)} cards directly here · ${subtreeCount(target)-directCount(target)} in descendants`}</p></div><div class="warehouse-list">${pickList(target,'target')}</div></section></div>
    ${lastTransfer ? `<div class="audit"><strong>Latest atomic transfer:</strong> source −${lastTransfer.quantity}, destination +${lastTransfer.quantity}; Collection remains ${totalCards()} cards.</div>` : '<div class="audit"><strong>Ready:</strong> choose a source card, set the quantity, and commit the move. Try moving more copies than available to see the safety behavior.</div>'}
  </section>`);
}

function isOrganizational(location) { return !!location && location.type === 'location' && children(location.id).length > 0; }
function dTreeRows(parent = null, depth = 0) {
  return locations.filter(location => location.parent === parent).map(location => {
    const organizational = isOrganizational(location);
    return `<button class="d-tree-row ${location.id === selectedLocation ? 'active' : ''}" style="--depth:${depth}" data-location="${location.id}">
      <span class="d-tree-icon">${location.type === 'deck' ? '◆' : organizational ? '▾' : '□'}</span>
      <span><strong>${location.name}</strong><small>${location.type === 'deck' ? 'Deck · storage leaf' : organizational ? 'Organizational · subtree only' : 'Storage leaf'}</small></span>
      <span class="d-tree-count">${subtreeCount(location)}<small>${organizational ? 'subtree' : 'stored'}</small></span>
    </button>${dTreeRows(location.id, depth + 1)}`;
  }).join('');
}
function dTopNav() {
  return `<nav class="d-nav" aria-label="Primary"><button class="${dView === 'locations' ? 'active' : ''}" data-d-view="locations">Locations</button><button class="${dView === 'collection' ? 'active' : ''}" data-d-view="collection">Collection</button></nav>`;
}
function dHeader() {
  return `<header class="d-header"><div class="brand"><span class="brand-mark">T</span> Cardstead</div>${dTopNav()}<div class="d-account">Demo Collector <span>RC</span></div></header>`;
}
function openDrawerButton(location, cardId) {
  return `<button class="text-button" data-open-transfer data-from="${location.id}" ${cardId ? `data-transfer-card="${cardId}"` : ''}>Move ${cardId ? 'copies' : 'cards'} →</button>`;
}
function dLocationView() {
  const current = loc(selectedLocation) || locations[0];
  const organizational = isOrganizational(current);
  return `<div class="d-layout"><aside class="d-sidebar"><div class="d-sidebar-title"><span>Physical organization</span><span class="pill">${locations.length}</span></div>${dTreeRows()}</aside>
    <section class="d-content"><div class="d-crumb">Locations / ${pathFor(current)}</div><div class="d-title-row"><div><p class="eyebrow">${current.type === 'deck' ? 'Deck · storage leaf' : organizational ? 'Organizational Location' : 'Storage Location'}</p><h1>${current.name}</h1></div><div class="d-actions">${current.type !== 'deck' ? '<button class="button secondary" data-add-child>Add child Location</button>' : ''}${!organizational && directCount(current)>0 ? `<button class="button" data-open-transfer data-from="${current.id}">Move cards</button>` : ''}</div></div>
      ${organizational ? `<div class="org-banner"><span class="org-icon">⌘</span><div><strong>This Location organizes its children.</strong><p>It holds no cards itself. Its ${subtreeCount(current)}-card total is the sum of every storage leaf beneath it.</p></div></div>
      <div class="subtree-summary"><span>Cards in subtree</span><strong>${subtreeCount(current)}</strong><span>across ${descendants(current.id).filter(l => !isOrganizational(l)).length} storage leaves</span></div>
      <div class="child-grid">${children(current.id).map(child => `<button data-location="${child.id}"><span>${child.type === 'deck' ? '◆' : isOrganizational(child) ? '▾' : '□'}</span><strong>${child.name}</strong><small>${isOrganizational(child) ? `${subtreeCount(child)} in subtree` : `${directCount(child)} stored here`}</small></button>`).join('')}</div>` : `<div class="storage-callout"><span><strong>${current.type === 'deck' ? 'Decks always remain storage leaves.' : 'Cards are physically stored here.'}</strong><small>${current.type === 'deck' ? 'It cannot contain child Locations.' : 'Adding its first child requires moving these cards into a storage leaf.'}</small></span><strong>${directCount(current)} cards</strong></div>
      <section class="d-card-list"><div class="d-list-head"><span>Card Edition</span><span>Quantity</span><span></span></div>${Object.entries(current.holdings).filter(([,q])=>q>0).map(([id,qty]) => `<div class="d-card-row">${cardArt(cards[id])}<span><strong>${cards[id].name}</strong><small>${cards[id].detail}</small></span><strong>×${qty}</strong>${openDrawerButton(current,id)}</div>`).join('') || '<div class="empty">This storage leaf is empty.</div>'}</section>`}
      <button class="bulk-link" data-open-bulk><span>⇄</span><span><strong>Need to reorganize several Card Editions?</strong><small>Open Bulk transfer for one all-or-nothing move.</small></span><span>Open workspace →</span></button>
    </section></div>`;
}
function dCollectionView() {
  return `<section class="d-collection"><div class="d-crumb">Collection</div><div class="d-title-row"><div><p class="eyebrow">Aggregate view</p><h1>${totalCards()} cards in your Collection</h1><p class="lede">One row per Card Edition, totaled across every storage Location and Deck.</p></div></div>
    <div class="d-collection-table"><div class="d-list-head"><span>Card Edition</span><span>Total</span><span>Physical distribution</span><span></span></div>${Object.values(cards).map(card => {
      const distribution=locations.filter(l=>cardAt(l,card.id)>0);
      const action=distribution[0]?(currentVariant()==='F'?`<button class="text-button" data-location="${distribution[0].id}" data-d-view-jump="locations">Open Location →</button>`:openDrawerButton(distribution[0],card.id)):'';
      return `<div class="d-collection-row">${cardArt(card)}<span><strong>${card.name}</strong><small>${card.detail}</small></span><strong class="d-total">×${cardTotal(card.id)}</strong><span class="distribution-chips">${distribution.map(l=>`<button data-location="${l.id}" data-d-view-jump="locations">${l.type === 'deck' ? '◆ ' : ''}${l.name} · ${cardAt(l,card.id)}</button>`).join('')}</span><span>${action}</span></div>`;
    }).join('')}</div><button class="bulk-link" data-open-bulk><span>⇄</span><span><strong>Move several Card Editions together</strong><small>Every row succeeds, or none of them do.</small></span><span>Open Bulk transfer →</span></button></section>`;
}
function bulkRowMarkup(row, index) {
  let source=loc(row.from);
  if(!source || isOrganizational(source)) { source=locations.find(l=>!isOrganizational(l)&&directCount(l)>0); row.from=source.id; }
  const available=Object.entries(source.holdings).filter(([,q])=>q>0);
  if(!available.some(([id])=>id===row.card)) row.card=available[0]?.[0] || 'pikachu';
  if(row.to===source.id || isOrganizational(loc(row.to))) row.to=locations.find(l=>!isOrganizational(l)&&l.id!==source.id).id;
  return `<div class="bulk-row" data-bulk-row="${row.id}"><span class="bulk-number">${index+1}</span><div class="field"><label>From storage leaf</label><select data-bulk-field="from">${locations.filter(l=>!isOrganizational(l)).map(l=>`<option value="${l.id}" ${l.id===source.id?'selected':''}>${l.type==='deck'?'◆ ':''}${l.name}</option>`).join('')}</select></div><div class="field"><label>Card Edition</label><select data-bulk-field="card">${available.map(([id,q])=>`<option value="${id}" ${id===row.card?'selected':''}>${cards[id].name} · ${q} available</option>`).join('')}</select></div><div class="field qty-field"><label>Quantity</label><input data-bulk-field="quantity" type="number" min="1" value="${row.quantity}"></div><div class="bulk-arrow">→</div><div class="field"><label>To storage leaf</label><select data-bulk-field="to">${locations.filter(l=>!isOrganizational(l)&&l.id!==source.id).map(l=>`<option value="${l.id}" ${l.id===row.to?'selected':''}>${l.type==='deck'?'◆ ':''}${l.name}</option>`).join('')}</select></div><button class="icon-button" data-remove-bulk aria-label="Remove row">×</button></div>`;
}
function dBulkView() {
  return `<section class="d-bulk"><button class="back-button" data-d-view="locations">← Back to Locations</button><p class="eyebrow">Dedicated workspace</p><h1>Bulk transfer</h1><p class="lede">Plan any number of physical moves. We validate every row against one snapshot before changing a single quantity.</p><div class="bulk-head"><span>${bulkRows.length} transfer rows</span><button class="button secondary" data-add-bulk>+ Add another Card Edition</button></div><div class="bulk-rows">${bulkRows.map(bulkRowMarkup).join('')}</div><div class="bulk-commit"><div><strong>One atomic operation</strong><p>Every source is checked—including combined rows drawing from the same holding. If any row fails, the complete Collection stays unchanged.</p></div><div><span>Collection before and after: <strong>${totalCards()} cards</strong></span><button class="button" data-commit-bulk>Review & commit ${bulkRows.length} moves</button></div></div></section>`;
}
function dTransferDrawer() {
  if(!transferDrawer) return '';
  const from=loc(transferDrawer.from);
  const available=Object.entries(from.holdings).filter(([,q])=>q>0);
  if(!available.some(([id])=>id===transferDrawer.card)) transferDrawer.card=available[0]?.[0];
  if(!transferDrawer.to || transferDrawer.to===from.id || isOrganizational(loc(transferDrawer.to))) transferDrawer.to=locations.find(l=>!isOrganizational(l)&&l.id!==from.id).id;
  return `<div class="drawer-scrim" data-close-drawer></div><aside class="transfer-drawer"><div class="drawer-head"><div><p class="eyebrow">Single transfer</p><h2>Confirm physical move</h2></div><button class="icon-button" data-close-drawer>×</button></div><form data-d-transfer><div class="drawer-context"><span>From</span><strong>${pathFor(from)}</strong><small>${directCount(from)} cards stored here</small></div><div class="field"><label>Card Edition</label><select name="card">${available.map(([id,q])=>`<option value="${id}" ${id===transferDrawer.card?'selected':''}>${cards[id].name} · ${q} available</option>`).join('')}</select></div><div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" value="1" required></div><div class="field"><label>To storage leaf</label><select name="to">${locations.filter(l=>!isOrganizational(l)&&l.id!==from.id).map(l=>`<option value="${l.id}" ${l.id===transferDrawer.to?'selected':''}>${l.type==='deck'?'◆ ':''}${pathFor(l)}</option>`).join('')}</select></div><div class="drawer-confirm"><strong>Confirm before changing inventory</strong><p>This subtracts and adds together. Failure leaves both Locations unchanged.</p></div><button class="button" type="submit">Confirm transfer</button><button class="button secondary" type="button" data-open-bulk>Switch to Bulk transfer</button></form></aside>`;
}
function dConversionDialog() {
  if(!conversionDialog) return '';
  const current=loc(conversionDialog.locationId), stocked=directCount(current)>0;
  return `<div class="modal-scrim"><section class="conversion-modal"><p class="eyebrow">Guided conversion</p><h2>${stocked ? 'This storage leaf already holds cards' : children(current.id).length ? 'Add another child Location' : 'Add the first child Location'}</h2><p class="lede">${stocked ? `${current.name} must become organizational, so its ${directCount(current)} cards need a storage leaf. Choose where they go.` : `${current.name} will organize the new storage child.`}</p><div class="field"><label>New child name</label><input data-child-name value="${conversionDialog.childName}"></div>${stocked ? `<label class="choice ${conversionDialog.mode==='new'?'active':''}"><input type="radio" name="conversion-mode" value="new" ${conversionDialog.mode==='new'?'checked':''}><span><strong>Move all to the new child</strong><small>Recommended · creates one new storage leaf and moves every current holding into it atomically.</small></span></label><label class="choice ${conversionDialog.mode==='unsorted'?'active':''}"><input type="radio" name="conversion-mode" value="unsorted" ${conversionDialog.mode==='unsorted'?'checked':''}><span><strong>Create an Unsorted child</strong><small>Keeps existing cards separate while also creating the named empty child.</small></span></label>` : ''}<div class="modal-actions"><button class="button secondary" data-cancel-conversion>Cancel</button><button class="button" data-confirm-conversion>${stocked ? 'Convert atomically' : 'Create child'}</button></div><div class="atomic-note">The parent changes role only if child creation and every holding move succeed together.</div></section></div>`;
}
function variantD() {
  const content=dView==='collection'?dCollectionView():dView==='bulk'?dBulkView():dLocationView();
  const success=lastTransfer?.conversion?'Location converted and holdings moved atomically':lastTransfer?.bulk?`${lastTransfer.quantity} transfer rows committed atomically`:lastTransfer?`${lastTransfer.quantity}× ${cards[lastTransfer.card].name} moved atomically`:'';
  return `<div class="prototype-ribbon">Throwaway prototype · Variant D synthesizes confirmed decisions · refresh resets everything</div>${dHeader()}<main class="d-page">${success?`<div class="d-success">✓ ${success}</div>`:''}${content}</main>${dTransferDrawer()}${dConversionDialog()}${switcher()}`;
}

function eSelectedTotal() { return Object.values(eSelection).reduce((sum,count)=>sum+count,0); }
function eSelectedEditions() { return Object.entries(eSelection).filter(([,count])=>count>0); }
function eTreeRows(parent=null,depth=0) {
  return locations.filter(location=>location.parent===parent).map(location=>{
    const organizational=isOrganizational(location), validDrop=!organizational;
    return `<button class="e-tree-row ${location.id===selectedLocation?'active':''} ${validDrop?'drop-leaf':''}" style="--depth:${depth}" data-location="${location.id}" ${validDrop?'data-e-drop-target':''}>
      <span>${location.type==='deck'?'◆':organizational?'▾':'□'}</span><span><strong>${location.name}</strong><small>${location.type==='deck'?'Deck · leaf':organizational?'Folder':`${directCount(location)} cards`}</small></span><span>${subtreeCount(location)}</span>
    </button>${eTreeRows(location.id,depth+1)}`;
  }).join('');
}
function ePreview(card,quantity,location,index) {
  return `<span class="e-preview" role="tooltip"><strong>${card.name}</strong><span>${card.detail}</span><span>${index ? `Temporary copy ${index} of ${quantity}` : `${quantity} copies in this Holding`}</span><span>${pathFor(location)}</span></span>`;
}
function eHoldingStack(location,cardId,quantity) {
  const card=cards[cardId],selected=eSelection[cardId]||0,fanned=eFanned.has(cardId),allSelected=selected===quantity,handles=eHandleSelections[cardId]||new Set();
  if(fanned) return `<article class="e-holding fanned"><div class="e-holding-head"><label><input type="checkbox" data-e-toggle-holding="${cardId}" ${allSelected?'checked':''}> <strong>${card.name}</strong></label><button class="text-button" data-e-collapse="${cardId}">Collapse</button></div><div class="e-copy-grid">${Array.from({length:quantity},(_,i)=>`<label class="e-card-thumb e-copy ${handles.has(i)?'selected':''}" tabindex="0" draggable="${handles.has(i)}" data-e-drag-card="${cardId}"><input type="checkbox" data-e-copy="${cardId}" data-copy-index="${i}" ${handles.has(i)?'checked':''}>${cardArt(card,true)}<span class="copy-index">${i+1}</span>${ePreview(card,quantity,location,i+1)}</label>`).join('')}</div></article>`;
  return `<article class="e-holding"><label class="e-card-thumb e-stack ${selected?'selected':''}" tabindex="0" draggable="${selected>0}" data-e-drag-card="${cardId}"><input type="checkbox" data-e-toggle-holding="${cardId}" ${allSelected?'checked':''}>${cardArt(card)}<span class="stack-layer one"></span><span class="stack-layer two"></span><strong class="quantity-badge">×${quantity}</strong>${ePreview(card,quantity,location)}</label><div class="e-stack-meta"><strong>${card.name}</strong><span>${quantity} in one Holding</span><button class="text-button" data-e-fan="${cardId}">Fan out ${quantity} handles</button></div></article>`;
}
function eLocationView() {
  const current=loc(selectedLocation)||locations[0],organizational=isOrganizational(current),holdings=Object.entries(current.holdings).filter(([,q])=>q>0),isF=currentVariant()==='F';
  return `<div class="e-browser"><aside class="e-tree"><div class="e-tree-title">Locations ${current.type!=='deck'?'<button class="icon-button" data-add-child title="Add child Location">+</button>':''}</div><div class="e-tree-scroll">${eTreeRows()}</div><div class="e-tree-help">Drag selected thumbnails onto a storage leaf. Drop opens review; it never moves immediately.</div></aside><section class="e-main"><div class="e-toolbar"><div><span class="d-crumb">Locations / ${pathFor(current)}</span><h1>${current.name}</h1><span class="pill ${current.type==='deck'?'deck':''}">${current.type==='deck'?'◆ Deck · storage leaf':organizational?'Folder · organizational':'□ Storage leaf'}</span></div><div class="e-view-actions">${current.type!=='deck'?'<button class="button secondary" data-add-child>New child folder</button>':''}${!organizational&&holdings.length?'<button class="button secondary" data-e-select-all>Select all</button>':''}</div></div>
    ${organizational?`<div class="e-folder-grid">${children(current.id).map(child=>`<button data-location="${child.id}"><span class="folder-icon">${child.type==='deck'?'◆':'▰'}</span><strong>${child.name}</strong><small>${isOrganizational(child)?`${children(child.id).length} folders · ${subtreeCount(child)} cards`:`${directCount(child)} cards stored`}</small></button>`).join('')}</div><div class="org-banner"><span class="org-icon">⌘</span><div><strong>Folders organize; they do not store.</strong><p>${subtreeCount(current)} cards are held by the storage leaves beneath this Location.</p></div></div>`:`<div class="e-grid-head"><span>${holdings.length} Card Editions · ${directCount(current)} copies</span><span>Collapsed stacks are Holdings, not individually persisted cards.</span></div><div class="e-thumbnail-grid">${holdings.map(([id,q])=>eHoldingStack(current,id,q)).join('')||'<div class="empty">This storage leaf is empty.</div>'}</div>`}
    ${isF?'':`<button class="bulk-link" data-open-bulk><span>⇄</span><span><strong>Bulk transfer without selecting thumbnails</strong><small>Build an unrestricted all-or-nothing move.</small></span><span>Open workspace →</span></button>`}</section></div>${eActionBar(current,isF)}`;
}
function eActionBar(current,isF=false) {
  const total=eSelectedTotal(),editions=eSelectedEditions().length;
  if(!total||isOrganizational(current))return '';
  return `<div class="e-action-bar ${fSelectionError&&isF?'has-error':''}"><span><strong>${total}</strong> copies selected across <strong>${editions}</strong> Card Edition${editions===1?'':'s'}${fSelectionError&&isF?`<small>${fSelectionError}</small>`:''}</span><button class="text-button" data-e-clear>Clear</button><button class="button" ${isF?'data-f-move':'data-e-move'}>Move selected →</button></div>`;
}
function variantE() {
  const content=dView==='collection'?dCollectionView():dView==='bulk'?dBulkView():eLocationView();
  const success=lastTransfer?.conversion?'Location converted and holdings moved atomically':lastTransfer?.bulk?`${lastTransfer.quantity} transfer rows committed atomically`:lastTransfer?`${lastTransfer.quantity}× ${cards[lastTransfer.card].name} moved atomically`:'';
  return `<div class="prototype-ribbon">Throwaway prototype · Variant E tests file-browser navigation and temporary copy handles</div>${dHeader()}<main class="d-page e-page">${success?`<div class="d-success">✓ ${success}</div>`:''}${content}</main>${dTransferDrawer()}${dConversionDialog()}${switcher()}`;
}
function fDestinationPicker() {
  if(!fPickerOpen)return '';
  const source=loc(selectedLocation),targets=locations.filter(l=>!isOrganizational(l)&&l.id!==source.id);
  if(!targets.some(l=>l.id===fTarget))fTarget=targets[0]?.id;
  return `<div class="drawer-scrim" data-f-close-picker></div><aside class="f-picker"><div class="drawer-head"><div><p class="eyebrow">Destination only</p><h2>Move ${eSelectedTotal()} selected copies</h2></div><button class="icon-button" data-f-close-picker>×</button></div><p class="lede">Your thumbnail selection is the review. Choose where the selected quantities should live.</p><div class="f-targets">${targets.map(target=>`<label class="f-target ${target.id===fTarget?'active':''}"><input type="radio" name="f-target" value="${target.id}" ${target.id===fTarget?'checked':''}><span>${target.type==='deck'?'◆':'□'}</span><span><strong>${target.name}</strong><small>${pathFor(target)} · ${directCount(target)} cards</small></span></label>`).join('')}</div><button class="button" data-f-commit>Move here</button><div class="atomic-note">All ${eSelectedEditions().length} selected Card Edition quantities move together, or nothing changes.</div></aside>`;
}
function fToastMarkup() {
  if(!fToast)return '';
  return `<div class="f-toast"><span><strong>${fToast.title}</strong><small>${fToast.detail}</small></span>${fUndo?'<button data-f-undo>Undo</button>':''}<button class="icon-button" data-f-dismiss>×</button></div>`;
}
function variantF() {
  const content=dView==='collection'?dCollectionView():eLocationView();
  return `<div class="prototype-ribbon">Throwaway prototype · Variant F tests selection-as-review and immediate drag</div>${dHeader()}<main class="d-page e-page">${content}</main>${fDestinationPicker()}${dConversionDialog()}${fToastMarkup()}${switcher()}`;
}
function executeFMove(targetId) {
  const source=loc(selectedLocation),target=loc(targetId),lines=eSelectedEditions().map(([card,quantity])=>({card,quantity}));
  fSelectionError=null;
  if(!source||isOrganizational(source)||!target||isOrganizational(target)||target.id===source.id||!lines.length) {
    fSelectionError='Move failed: choose a different storage leaf. Selection retained.'; fPickerOpen=false; render(); return false;
  }
  const draft=structuredClone(locations),draftSource=draft.find(l=>l.id===source.id),draftTarget=draft.find(l=>l.id===target.id);
  for(const line of lines) {
    if(!cards[line.card]||!Number.isInteger(line.quantity)||line.quantity<1||cardAt(draftSource,line.card)<line.quantity) {
      fSelectionError=`Move failed: ${cards[line.card]?.name||'a selected card'} is stale or insufficient. Selection retained.`; fPickerOpen=false; render(); return false;
    }
  }
  for(const line of lines){ draftSource.holdings[line.card]-=line.quantity;draftTarget.holdings[line.card]=cardAt(draftTarget,line.card)+line.quantity; }
  locations=draft;fUndo={from:source.id,to:target.id,lines};fToast={title:`Moved ${lines.reduce((s,l)=>s+l.quantity,0)} copies`,detail:`${lines.length} Card Edition${lines.length===1?'':'s'} · ${source.name} → ${target.name}`};fPickerOpen=false;eSelection={};eHandleSelections={};render();return true;
}
function undoFMove() {
  if(!fUndo)return;
  const move=fUndo,draft=structuredClone(locations),source=draft.find(l=>l.id===move.from),destination=draft.find(l=>l.id===move.to);
  if(!source||!destination||isOrganizational(loc(source.id))||isOrganizational(loc(destination.id))||move.lines.some(line=>cardAt(destination,line.card)<line.quantity)) { fToast={title:'Undo failed safely',detail:'A destination quantity changed; no inventory was modified.'};fUndo=null;render();return; }
  for(const line of move.lines){ destination.holdings[line.card]-=line.quantity;source.holdings[line.card]=cardAt(source,line.card)+line.quantity; }
  locations=draft;selectedLocation=move.from;eSelection=Object.fromEntries(move.lines.map(line=>[line.card,line.quantity]));eHandleSelections=Object.fromEntries(move.lines.map(line=>[line.card,new Set(Array.from({length:line.quantity},(_,i)=>i))]));fUndo=null;fToast={title:'Move undone',detail:`Restored ${move.lines.reduce((s,l)=>s+l.quantity,0)} copies to ${loc(move.from).name}`};render();
}
function openESelectedMove(targetId) {
  const selected=eSelectedEditions(),from=loc(selectedLocation);
  if(!from||isOrganizational(from)||!selected.length)return showError('select copies from a storage leaf first');
  const target=targetId&&loc(targetId);
  if(target&&(isOrganizational(target)||target.id===from.id))return showError('drop onto a different storage leaf');
  if(eSelectedTotal()===1) {
    transferDrawer={from:from.id,card:selected[0][0],to:target?.id||locations.find(l=>!isOrganizational(l)&&l.id!==from.id).id};
  } else {
    const fallback=target?.id||locations.find(l=>!isOrganizational(l)&&l.id!==from.id).id;
    bulkRows=selected.map(([card,quantity])=>({id:nextBulkRowId++,from:from.id,card,quantity,to:fallback})); dView='bulk';
  }
  render();
}

function confirmConversion() {
  const current=loc(conversionDialog?.locationId), name=conversionDialog?.childName.trim();
  if(!current || current.type==='deck') return showError('Decks cannot have child Locations');
  if(!name) return showError('enter a name for the new child Location');
  const draft=structuredClone(locations), draftParent=draft.find(l=>l.id===current.id);
  const newId=`custom-${nextLocationId++}`;
  if(directCount(current)>0 && conversionDialog.mode==='unsorted') {
    draft.push({id:`unsorted-${nextLocationId++}`,name:'Unsorted',parent:current.id,type:'location',holdings:structuredClone(draftParent.holdings)});
    draft.push({id:newId,name,parent:current.id,type:'location',holdings:{}});
  } else {
    draft.push({id:newId,name,parent:current.id,type:'location',holdings:structuredClone(draftParent.holdings)});
  }
  draftParent.holdings={}; locations=draft; selectedLocation=newId; conversionDialog=null; eSelection={}; eHandleSelections={};
  lastTransfer={conversion:true}; render();
}
function commitBulkTransfers() {
  if(!bulkRows.length) return showError('add at least one transfer row');
  const draft=structuredClone(locations), draftLoc=id=>draft.find(l=>l.id===id);
  for(let index=0;index<bulkRows.length;index++) {
    const row=bulkRows[index], from=draftLoc(row.from), to=draftLoc(row.to), amount=Number(row.quantity);
    if(!from||!to||from.id===to.id||isOrganizational(loc(from.id))||isOrganizational(loc(to.id))) return showError(`row ${index+1} must use two different storage leaves`);
    if(!cards[row.card]||!Number.isInteger(amount)||amount<1) return showError(`row ${index+1} needs a whole quantity of at least 1`);
    if(cardAt(from,row.card)<amount) return showError(`row ${index+1} exceeds the copies remaining at ${from.name}`);
    from.holdings[row.card]-=amount; to.holdings[row.card]=cardAt(to,row.card)+amount;
  }
  locations=draft; eSelection={}; eHandleSelections={}; lastTransfer={bulk:true,quantity:bulkRows.length}; render();
}

function currentVariant() { const value = new URLSearchParams(location.search).get('variant')?.toUpperCase(); return validVariants.includes(value) ? value : 'A'; }
function switcher() { const variant = currentVariant(); return `<nav class="switcher" aria-label="Prototype variant switcher"><button data-cycle="-1" aria-label="Previous variant">←</button><div class="switch-label">${variant} — ${variantNames[variant]}<div class="switch-hint">click or use ← →</div></div><button data-cycle="1" aria-label="Next variant">→</button></nav>`; }
function cycleVariant(direction) { const index = validVariants.indexOf(currentVariant()); const next = validVariants[(index + direction + validVariants.length) % validVariants.length]; if(next==='F'&&dView==='bulk')dView='locations'; const url = new URL(location.href); url.searchParams.set('variant',next); history.replaceState({},'',url); render(); }

function showError(message) {
  clearTimeout(toastTimer); lastTransfer = null;
  const prior = document.getElementById('toast'); if (prior) prior.remove();
  const notice = document.createElement('div'); notice.id='toast'; notice.className='toast error'; notice.textContent=`Move declined — ${message}. Nothing changed.`; document.body.appendChild(notice);
  toastTimer=setTimeout(()=>notice.remove(),3500);
}
function doTransfer(fromId,toId,cardId,quantity) {
  const from=loc(fromId), to=loc(toId), amount=Number(quantity);
  if (!from || !to || from.id === to.id) return showError('choose two different Locations');
  if (isOrganizational(from) || isOrganizational(to)) return showError('transfers must start and end at storage leaves');
  if (!cards[cardId] || !Number.isInteger(amount) || amount < 1) return showError('enter a whole quantity of at least 1');
  if (cardAt(from,cardId) < amount) return showError(`only ${cardAt(from,cardId)} available at ${from.name}`);
  from.holdings[cardId] -= amount; to.holdings[cardId] = cardAt(to,cardId)+amount;
  selectedCard=cardId; sourceLocation=fromId; targetLocation=toId; transferDrawer=null; eSelection={}; eHandleSelections={}; lastTransfer={from:fromId,to:toId,card:cardId,quantity:amount}; render();
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{ lastTransfer=null; document.getElementById('toast')?.remove(); },3500);
}

function render() {
  const variant=currentVariant();
  document.getElementById('app').innerHTML=variant==='B'?variantB():variant==='C'?variantC():variant==='D'?variantD():variant==='E'?variantE():variant==='F'?variantF():variantA();
}

document.addEventListener('click', event => {
  const cycle=event.target.closest('[data-cycle]'); if(cycle) return cycleVariant(Number(cycle.dataset.cycle));
  const viewButton=event.target.closest('[data-d-view]'); if(viewButton){ dView=viewButton.dataset.dView; transferDrawer=null; return render(); }
  const locationButton=event.target.closest('[data-location]'); if(locationButton){ selectedLocation=locationButton.dataset.location; eSelection={}; eHandleSelections={}; eFanned.clear(); if(locationButton.dataset.dViewJump)dView=locationButton.dataset.dViewJump; return render(); }
  const cardButton=event.target.closest('[data-card]'); if(cardButton){ selectedCard=cardButton.dataset.card; return render(); }
  const pick=event.target.closest('[data-pick-card]'); if(pick){ selectedCard=pick.dataset.pickCard; return render(); }
  const drawerButton=event.target.closest('[data-open-transfer]'); if(drawerButton){ const from=loc(drawerButton.dataset.from); if(isOrganizational(from))return showError('start a transfer from a storage leaf'); transferDrawer={from:from.id,card:drawerButton.dataset.transferCard||Object.entries(from.holdings).find(([,q])=>q>0)?.[0],to:'deck'}; return render(); }
  if(event.target.closest('[data-close-drawer]')) { transferDrawer=null; return render(); }
  if(event.target.closest('[data-open-bulk]')) { transferDrawer=null; dView='bulk'; return render(); }
  if(event.target.closest('[data-add-child]')) { conversionDialog={locationId:selectedLocation,childName:'Inner box',mode:'new'}; return render(); }
  if(event.target.closest('[data-cancel-conversion]')) { conversionDialog=null; return render(); }
  if(event.target.closest('[data-confirm-conversion]')) return confirmConversion();
  if(event.target.closest('[data-add-bulk]')) { const from=locations.find(l=>!isOrganizational(l)&&directCount(l)>0); const to=locations.find(l=>!isOrganizational(l)&&l.id!==from.id); bulkRows.push({id:nextBulkRowId++,from:from.id,card:Object.entries(from.holdings).find(([,q])=>q>0)[0],quantity:1,to:to.id}); return render(); }
  const removeBulk=event.target.closest('[data-remove-bulk]'); if(removeBulk){ const id=Number(removeBulk.closest('[data-bulk-row]').dataset.bulkRow); bulkRows=bulkRows.filter(row=>row.id!==id); return render(); }
  if(event.target.closest('[data-commit-bulk]')) return commitBulkTransfers();
  const fan=event.target.closest('[data-e-fan]'); if(fan){ eFanned.add(fan.dataset.eFan); return render(); }
  const collapse=event.target.closest('[data-e-collapse]'); if(collapse){ eFanned.delete(collapse.dataset.eCollapse); return render(); }
  if(event.target.closest('[data-e-select-all]')) { const current=loc(selectedLocation); eSelection=Object.fromEntries(Object.entries(current.holdings).filter(([,q])=>q>0)); eHandleSelections=Object.fromEntries(Object.entries(current.holdings).filter(([,q])=>q>0).map(([id,q])=>[id,new Set(Array.from({length:q},(_,i)=>i))])); return render(); }
  if(event.target.closest('[data-e-clear]')) { eSelection={}; eHandleSelections={}; fSelectionError=null; return render(); }
  if(event.target.closest('[data-e-move]')) return openESelectedMove();
  if(event.target.closest('[data-f-move]')) { fPickerOpen=true; fSelectionError=null; fTarget=locations.find(l=>!isOrganizational(l)&&l.id!==selectedLocation)?.id; return render(); }
  if(event.target.closest('[data-f-close-picker]')) { fPickerOpen=false; return render(); }
  if(event.target.closest('[data-f-commit]')) return executeFMove(fTarget);
  if(event.target.closest('[data-f-undo]')) return undoFMove();
  if(event.target.closest('[data-f-dismiss]')) { fToast=null; fUndo=null; return render(); }
});
document.addEventListener('change', event => {
  if(event.target.matches('[data-workspace-source]')) { sourceLocation=event.target.value; const first=Object.entries(loc(sourceLocation).holdings).find(([,q])=>q>0); if(first) selectedCard=first[0]; if(sourceLocation===targetLocation) targetLocation=locations.find(l=>l.id!==sourceLocation).id; return render(); }
  if(event.target.matches('[data-workspace-target]')) { targetLocation=event.target.value; return render(); }
  if(event.target.matches('[data-source]')) { const form=event.target.closest('form'), source=loc(event.target.value); form.querySelector('[name=card]').innerHTML=cardOptions(source,Object.keys(source.holdings)[0]); }
  if(event.target.matches('[name=conversion-mode]')) { conversionDialog.mode=event.target.value; return render(); }
  const bulkField=event.target.closest('[data-bulk-field]'); if(bulkField){ const row=bulkRows.find(item=>item.id===Number(bulkField.closest('[data-bulk-row]').dataset.bulkRow)); const field=bulkField.dataset.bulkField; row[field]=field==='quantity'?Number(bulkField.value):bulkField.value; if(field==='from'){ const source=loc(row.from); row.card=Object.entries(source.holdings).find(([,q])=>q>0)?.[0]; if(row.to===row.from)row.to=locations.find(l=>!isOrganizational(l)&&l.id!==row.from).id; return render(); } }
  const holdingToggle=event.target.closest('[data-e-toggle-holding]'); if(holdingToggle){ const id=holdingToggle.dataset.eToggleHolding,qty=cardAt(loc(selectedLocation),id); eSelection[id]=holdingToggle.checked?qty:0; eHandleSelections[id]=holdingToggle.checked?new Set(Array.from({length:qty},(_,i)=>i)):new Set(); return render(); }
  const copyToggle=event.target.closest('[data-e-copy]'); if(copyToggle){ const id=copyToggle.dataset.eCopy,index=Number(copyToggle.dataset.copyIndex),set=eHandleSelections[id]||new Set(); copyToggle.checked?set.add(index):set.delete(index); eHandleSelections[id]=set;eSelection[id]=set.size; return render(); }
  if(event.target.matches('[name=f-target]')) { fTarget=event.target.value; return render(); }
});
document.addEventListener('input', event => { if(event.target.matches('[data-child-name]')&&conversionDialog)conversionDialog.childName=event.target.value; });
document.addEventListener('submit', event => {
  const dForm=event.target.closest('[data-d-transfer]'); if(dForm){ event.preventDefault(); const data=new FormData(dForm); return doTransfer(transferDrawer.from,data.get('to'),data.get('card'),Number(data.get('quantity'))); }
  const form=event.target.closest('[data-transfer-form]'); if(!form)return; event.preventDefault(); const data=new FormData(form); doTransfer(data.get('from'),data.get('to'),data.get('card'),Number(data.get('quantity')));
});
document.addEventListener('keydown', event => {
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return; const tag=event.target.tagName; if(['INPUT','TEXTAREA','SELECT'].includes(tag)||event.target.isContentEditable)return; event.preventDefault(); cycleVariant(event.key==='ArrowRight'?1:-1);
});
window.addEventListener('popstate',render);
document.addEventListener('dragstart',event=>{ const thumb=event.target.closest('[data-e-drag-card]'); if(!thumb||!eSelectedTotal()){event.preventDefault();return;} dragSelection={from:selectedLocation,selection:structuredClone(eSelection)}; event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',`${eSelectedTotal()} selected copies`); });
document.addEventListener('dragover',event=>{ const target=event.target.closest('[data-e-drop-target]'); if(target&&dragSelection&&target.dataset.location!==dragSelection.from){event.preventDefault();event.dataTransfer.dropEffect='move';target.classList.add('drag-over');} });
document.addEventListener('dragleave',event=>event.target.closest('[data-e-drop-target]')?.classList.remove('drag-over'));
document.addEventListener('drop',event=>{ const target=event.target.closest('[data-e-drop-target]'); if(!target||!dragSelection)return; event.preventDefault(); target.classList.remove('drag-over'); const targetId=target.dataset.location; dragSelection=null; currentVariant()==='F'?executeFMove(targetId):openESelectedMove(targetId); });
document.addEventListener('dragend',()=>{dragSelection=null;document.querySelectorAll?.('.drag-over').forEach(node=>node.classList.remove('drag-over'));});
render();

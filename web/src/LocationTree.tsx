import React, { useEffect, useMemo, useState } from 'react';
import { createLocation, editLocation, getLocationTree, LocationError, type TreeNode } from './location_generated';
import { Holdings } from './Holdings';
import './LocationTree.css';

type Action = 'create' | 'rename' | 'move' | null;

export function LocationTree() {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh(preferred?: string) {
    const result = await getLocationTree();
    setNodes(result.locations);
    setSelected(current => preferred ?? (current && result.locations.some(node => node.id === current) ? current : result.locations.find(node => node.name === 'Unsorted')?.id ?? result.locations[0]?.id ?? null));
  }
  useEffect(() => { void refresh().catch(() => setMessage('Locations are temporarily unavailable.')); }, []);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const current = selected ? byId.get(selected) : undefined;
  const breadcrumbs: TreeNode[] = [];
  for (let node = current; node; node = node.parent_id ? byId.get(node.parent_id) : undefined) breadcrumbs.unshift(node);
  const children = (parent: string | null) => nodes.filter(node => node.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name));
  function open(next: Action) {
    setAction(next); setMessage(''); setName(next === 'rename' ? current?.name ?? '' : '');
    setParentId(next === 'move' ? current?.parent_id ?? '' : current?.kind === 'storage_leaf' ? current.id : '');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true); setMessage('');
    try {
      const parent = parentId ? byId.get(parentId) : undefined;
      const key = crypto.randomUUID();
      if (action === 'create') {
        const result = await createLocation({ name, parent_id: parentId || null, parent_version: parent?.version ?? null, idempotency_key: key });
        await refresh(result.location.id);
      } else if (current && action === 'rename') {
        await editLocation(current.id, { name, version: current.version, idempotency_key: key });
        await refresh(current.id);
      } else if (current) {
        await editLocation(current.id, { parent_id: parentId || null, parent_version: parent?.version ?? null, version: current.version, idempotency_key: key });
        await refresh(current.id);
      }
      setAction(null); setDrawer(false);
    } catch (cause) {
      const code = cause instanceof LocationError ? cause.code : 'LOCATION_REQUEST_FAILED';
      const messages: Record<string, string> = {
        STALE_LOCATION: 'This Location changed in another tab. The tree has been refreshed; review it and try again.',
        LOCATION_NAME_CONFLICT: 'A sibling already has that name.',
        LOCATION_CYCLE: 'A Location cannot be moved inside itself or one of its descendants.',
        LOCATION_DEPTH_LIMIT: 'Locations can be nested at most 12 levels deep.',
        DECK_CANNOT_HAVE_CHILDREN: 'A Deck cannot contain Locations.',
        STOCKED_LOCATION_REQUIRES_CONVERSION: 'This Location contains cards. A guided conversion is required before this change.',
        INVALID_LOCATION_NAME: 'Enter a name of 1 to 120 characters.',
      };
      setMessage(messages[code] ?? 'Unable to save the Location. Please retry.');
      if (code === 'STALE_LOCATION' || code === 'LOCATION_NOT_FOUND') await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }
  function select(id: string) { setSelected(id); setDrawer(false); setAction(null); }
  function branch(parent: string | null): React.ReactNode {
    return <ul>{children(parent).map(node => <li key={node.id}><button className={node.id === selected ? 'tree-item active' : 'tree-item'} onClick={() => select(node.id)} aria-current={node.id === selected ? 'page' : undefined}>{node.name}</button>{children(node.id).length > 0 && branch(node.id)}</li>)}</ul>;
  }
  return <section className="location-layout" aria-label="Locations">
    <aside id="location-drawer" className={drawer ? 'location-sidebar open' : 'location-sidebar'} aria-label="Locations tree">
      <div className="sidebar-heading"><h2>Storage tree</h2><button className="mobile-only" onClick={() => setDrawer(false)}>Close</button></div>
      <nav aria-label="Location tree">{branch(null)}</nav>
      <button onClick={() => { setDrawer(false); open('create'); setParentId(''); }}>New top-level Location</button>
    </aside>
    <div className="location-content">
      <button className="mobile-only" onClick={() => setDrawer(true)} aria-expanded={drawer} aria-controls="location-drawer">Browse Locations</button>
      <nav className="breadcrumbs" aria-label="Location breadcrumbs"><button onClick={() => { setDrawer(true); setSelected(null); }}>All Locations</button>{breadcrumbs.map(node => <React.Fragment key={node.id}><span aria-hidden="true"> / </span><button onClick={() => select(node.id)}>{node.name}</button></React.Fragment>)}</nav>
      {current ? <><header className="location-heading"><div><h2>{current.name}</h2><p>{current.kind === 'organization' ? 'Organizational Location' : current.kind === 'deck' ? 'Deck' : 'Storage Leaf'}</p></div>{current.kind !== 'deck' && <div className="location-actions"><button onClick={() => open('rename')}>Rename</button><button onClick={() => open('move')}>Move Location</button><button onClick={() => { open('create'); setParentId(current.id); }}>New child</button></div>}</header>
        {current.kind === 'organization' ? <section aria-label="Child Locations"><h3>Inside this Location</h3>{children(current.id).map(node => <button className="child-location" key={node.id} onClick={() => select(node.id)}>{node.name}</button>)}</section> : <Holdings key={current.id} locationId={current.id} locationName={current.name} />}
      </> : <p>Select a Location from the tree.</p>}
      {action && <form className="location-form" onSubmit={save}><h3>{action === 'create' ? 'New Location' : action === 'rename' ? 'Rename Location' : 'Move Location'}</h3>
        {action !== 'move' && <label>Name <input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>}
        {action !== 'rename' && <label>Parent Location <select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">Top level</option>{nodes.filter(node => node.kind !== 'deck').map(node => <option key={node.id} value={node.id}>{'  '.repeat(node.depth - 1)}{node.name}</option>)}</select></label>}
        <div className="form-actions"><button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" onClick={() => setAction(null)}>Cancel</button></div>
      </form>}
      <p role="alert">{message}</p>
    </div>
  </section>;
}

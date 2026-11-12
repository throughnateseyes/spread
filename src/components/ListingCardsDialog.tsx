import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { cardAddressLine, cardDetailsLine, croppedPhotoUrl, LISTING_FIELD_LABEL, parseListingLinks, sortListings, type ListingSort } from '../email/listings';
import { cardCount, describeCardSet, fillCardsFromListings, findCardSet, readListings, type ListingRead } from '../email/listingcards';
import { isElectron } from '../platform';
import { Button, Modal, Segmented } from '../ui/controls';
import './listingcards.css';

// "Fill cards from listing links…": paste the links, check what each page says, fill the cards.
// Opened from the Email section of the right panel and from an email row's menu.

interface DialogState {
  boardId: string | null;
}

const useListingDialog = create<DialogState>(() => ({ boardId: null }));

/** Opens the dialog for an email board (default the active one). */
export function openListingCards(boardId?: string) {
  const s = useStore.getState();
  const id = boardId ?? s.project.activeBoardId;
  if (id !== s.project.activeBoardId) s.setActiveBoard(id);
  useListingDialog.setState({ boardId: id });
}

const close = () => useListingDialog.setState({ boardId: null });

/** "price", "price or photo", "price, beds or photo". */
const orList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);

export default function ListingCardsDialog() {
  const boardId = useListingDialog((s) => s.boardId);
  if (!boardId) return null;
  return <ListingCards key={boardId} boardId={boardId} />;
}

function ListingCards({ boardId }: { boardId: string }) {
  const doc = useStore((s) => s.project.boards.find((b) => b.id === boardId));
  const [text, setText] = useState('');
  const [sort, setSort] = useState<ListingSort>('price');
  const [reads, setReads] = useState<ListingRead[] | null>(null);
  const [readFor, setReadFor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const urls = useMemo(() => parseListingLinks(text), [text]);
  const key = urls.join('\n');
  const current = reads && readFor === key ? reads : null;
  const set = useMemo(() => (doc ? findCardSet(doc) : null), [doc]);
  const have = cardCount(set);

  const found = current ? sortListings(current.filter((r) => r.facts).map((r) => ({ ...r, price: r.facts!.price })), sort) : [];
  const failed = current ? current.filter((r) => !r.facts) : [];

  const check = async () => {
    setError(null);
    setBusy(`Reading ${urls.length} ${urls.length === 1 ? 'page' : 'pages'}…`);
    try {
      const r = await readListings(urls, (done, total) => setBusy(`Read ${done} of ${total}…`));
      setReads(r);
      setReadFor(key);
    } finally {
      setBusy(null);
    }
  };

  const fill = async () => {
    if (!current) return;
    setError(null);
    setBusy('Filling the cards…');
    try {
      const report = await fillCardsFromListings(current, { sort, boardId, onProgress: setBusy });
      useStore.getState().toast(report.summary, report.failed.length || report.cards.some((c) => c.problems.length) ? 'info' : 'success');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!doc) return null;
  const n = found.length;
  const plan = !current
    ? describeCardSet(set)
    : !set
      ? null
      : !n
        ? 'None of the links could be read.'
      : n > have
        ? `${describeCardSet(set)}. ${n - have} more will be added.`
        : n < have
          ? `${describeCardSet(set)}. ${have - n === 1 ? `Card ${have} stays` : `Cards ${n + 1}–${have} stay`} as ${have - n === 1 ? 'it is' : 'they are'}.`
          : `${describeCardSet(set)}, one per link.`;

  return (
    <Modal
      title="Fill cards from listing links"
      width={720}
      onClose={close}
      footer={
        <>
          <span className="lc-status">{busy ?? (error ? <span className="lc-error">{error}</span> : plan)}</span>
          <Button onClick={close}>Cancel</Button>
          {current && n ? (
            <Button primary disabled={!!busy || !set} onClick={() => void fill()}>
              Fill {n} {n === 1 ? 'card' : 'cards'}
            </Button>
          ) : (
            <Button primary disabled={!!busy || !urls.length} onClick={() => void check()}>
              Check links
            </Button>
          )}
        </>
      }
    >
      <div className="lc">
        <textarea
          className="lc-links"
          value={text}
          placeholder={'Paste listing links, one per line\nhttps://rentbt.com/listing/2238-hyde-street-unit-8/'}
          spellCheck={false}
          autoFocus
          rows={5}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="lc-row">
          <span className="lc-label">Order</span>
          <Segmented<ListingSort>
            value={sort}
            onChange={setSort}
            options={[
              { value: 'price', label: 'Price, low to high' },
              { value: 'as-given', label: 'As pasted' },
            ]}
          />
          <span className="lc-count">{urls.length ? `${urls.length} ${urls.length === 1 ? 'link' : 'links'}` : ''}</span>
          {current && (
            <Button disabled={!!busy} onClick={() => void check()} title="Read the pages again">
              Check again
            </Button>
          )}
        </div>
        {!set && <p className="lc-note warn">No listing cards on this board yet. Add a section with cards keyed unit-1-price, unit-1-address, unit-1-meta and unit-1-photo, or repeat a card with price, address, details and photo fields.</p>}
        {!isElectron && <p className="lc-note">Reading listing pages needs the Spread desktop app.</p>}
        {current && (
          <div className="lc-table">
            <table>
              <thead>
                <tr>
                  <th className="lc-num">Card</th>
                  <th />
                  <th>Price</th>
                  <th>Address</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {found.map((r, i) => {
                  const f = r.facts!;
                  const notes = [
                    ...(f.available === false ? ['Off the market'] : []),
                    ...(f.missing.length ? [`No ${orList(f.missing.map((m) => LISTING_FIELD_LABEL[m]))} on the page`] : []),
                  ];
                  return [
                    <tr key={r.url} className={notes.length ? 'lc-has-note' : ''}>
                      <td className="lc-num">{i + 1}</td>
                      <td className="lc-photo">{f.photos[0] ? <img src={croppedPhotoUrl(f.photos[0], 104, 68)} alt="" /> : <span>No photo</span>}</td>
                      <td>{f.priceText ?? <i>No price</i>}</td>
                      <td>
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {cardAddressLine(f) ?? r.url}
                        </a>
                      </td>
                      <td>{cardDetailsLine(f) ?? <i>Not found</i>}</td>
                    </tr>,
                    notes.length ? (
                      <tr key={r.url + '#note'} className="lc-warn">
                        <td />
                        <td colSpan={4}>{notes.join('. ')}. The card will show a placeholder to fix.</td>
                      </tr>
                    ) : null,
                  ];
                })}
                {failed.map((r) => (
                  <tr key={r.url} className="lc-warn lc-failed">
                    <td className="lc-num">–</td>
                    <td colSpan={4}>
                      <b>{r.url}</b>
                      <br />
                      {r.error} It won’t get a card.
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!current && urls.length > 0 && !busy && <p className="lc-note">Check the links to see what each page says before filling the cards.</p>}
      </div>
    </Modal>
  );
}

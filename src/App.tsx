import { useEffect } from 'react';
import { useStore } from './store';
import TopBar from './components/TopBar';
import Canvas from './components/Canvas';
import LeftPanel from './components/LeftPanel';
import RightPanel from './components/RightPanel';
import ExportDialog from './components/ExportDialog';
import PreviewModal from './components/PreviewModal';
import ArrangeDialog from './components/ArrangeDialog';
import RepeatDialog from './components/RepeatDialog';
import ListingCardsDialog from './components/ListingCardsDialog';
import StylesDialog from './components/StylesPanel';
import EmailExportDialog from './components/EmailExportDialog';
import InboxPreviewDialog from './components/InboxPreview';
import PdfExportDialog from './components/PdfExportDialog';
import ClaudeDialog from './components/ClaudeDialog';
import BrandsDialog from './components/BrandsDialog';
import ClaudePanel, { chatWidth } from './components/ClaudePanel';
import FolderPickerHost from './components/FolderPicker';
import { CanvasDock, NewBoardDialog } from './components/NewBoard';
import { emailRootOf } from './email/boards';
import { Modal } from './ui/controls';
import { installShortcuts, SHORTCUTS } from './shortcuts';
import { installClipboard } from './clipboard';
import { installAutomation } from './automation';
import { loadBrands } from './brand';
import { loadLibrary } from './library';
import { LibraryDialog, SaveToLibraryDialog } from './components/LibraryDialogs';
import { installChat } from './chat';
import { isElectron } from './platform';
import { ensureDocFonts } from './fonts';
import { restoreAutosave, startAutosave } from './project';
import { initWorkspace } from './workspace';
import TabBar from './components/TabBar';
import Home from './components/Home';
import Switcher from './components/Switcher';

export default function App() {
  const modal = useStore((s) => s.modal);
  const toasts = useStore((s) => s.toasts);
  const doc = useStore((s) => s.doc);
  const chatOpen = useStore((s) => s.chatOpen) && isElectron;
  const homeOpen = useStore((s) => s.homeOpen);

  useEffect(() => {
    const offs = [installShortcuts(), installClipboard(), installAutomation(), installChat()];
    document.documentElement.style.setProperty('--chat-w', `${chatWidth()}px`);
    try {
      if (isElectron && localStorage.getItem('spread.chatOpen')) useStore.getState().set({ chatOpen: true });
    } catch {
      // storage unavailable
    }
    void loadBrands();
    void loadLibrary();
    let stopAutosave: (() => void) | void;
    (isElectron ? initWorkspace().then(() => false) : restoreAutosave())
      .then((restored) => {
        if (restored) {
          useStore.getState().toast('Restored your last session');
          window.dispatchEvent(new Event('spread:fit'));
        }
      })
      .catch(() => {})
      .finally(() => {
        stopAutosave = startAutosave();
      });
    return () => {
      offs.forEach((f) => f());
      if (typeof stopAutosave === 'function') stopAutosave();
    };
  }, []);

  useEffect(() => {
    ensureDocFonts(doc);
  }, [doc]);

  useEffect(() => {
    document.title = `${doc.name} — Spread`;
  }, [doc.name]);

  const close = () => useStore.getState().set({ modal: null });
  const emailRoot = emailRootOf(doc);
  return (
    <div className={`app ${chatOpen ? 'with-chat' : ''} ${isElectron ? 'with-tabs' : ''}`}>
      {isElectron && <TabBar />}
      <TopBar />
      <LeftPanel />
      <Canvas />
      <RightPanel />
      {chatOpen && <ClaudePanel />}
      <CanvasDock />
      {homeOpen && <Home />}
      {isElectron && <Switcher />}
      {modal === 'export' && (emailRoot ? <EmailExportDialog onClose={close} root={emailRoot} nodes={doc.nodes} /> : doc.kind === 'document' ? <PdfExportDialog /> : <ExportDialog />)}
      {modal === 'new-board' && <NewBoardDialog />}
      {modal === 'claude' && <ClaudeDialog />}
      {modal === 'brands' && <BrandsDialog />}
      {modal === 'library' && <LibraryDialog />}
      <SaveToLibraryDialog />
      {modal === 'preview' && <PreviewModal />}
      {modal === 'inbox' && emailRoot && <InboxPreviewDialog root={emailRoot} onClose={close} />}
      {modal === 'arrange' && <ArrangeDialog />}
      {modal === 'repeat' && <RepeatDialog />}
      <ListingCardsDialog />
      {modal === 'styles' && <StylesDialog />}
      {modal === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" onClose={close} width={560}>
          <div className="shortcuts">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="shortcut-row">
                <kbd>{k}</kbd>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <p className="hint">On Mac, Ctrl is ⌘.</p>
        </Modal>
      )}
      <FolderPickerHost />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

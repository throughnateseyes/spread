import { isElectron } from '../platform';
import { useStore } from '../store';
import { Button } from '../ui/controls';
import { IconFile } from '../ui/icons';

/** "Save as PDF" in the email export: swaps to the PDF dialog for the same board. */
export default function EmailPdfButton() {
  return (
    <Button onClick={() => useStore.getState().set({ modal: 'pdf' })} disabled={!isElectron} title={isElectron ? 'A PDF of the email, as one long page or Letter pages' : 'PDF export needs the desktop app'}>
      <IconFile size={14} /> Save as PDF
    </Button>
  );
}

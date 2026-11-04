import { useState } from 'react';
import { chooseExportFolder, exportFolderFor } from '../platform';
import { Tooltip } from '../ui/Tooltip';

// The "Save to" line in the export dialogs. Exports write straight into this folder (no picker in
// the way); Change… picks another, which is remembered for next time.

export function useExportFolder(projectName: string) {
  const [folder, setFolder] = useState(() => exportFolderFor(projectName));
  const change = async () => {
    const dir = await chooseExportFolder(folder);
    if (dir) setFolder(dir);
  };
  return { folder, change };
}

/** The last two parts of a path: "Spread/Pac Heights listing". */
const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/');

export function ExportFolderRow({ folder, onChange, disabled }: { folder: string; onChange: () => void; disabled?: boolean }) {
  return (
    <div className="io-field">
      <div className="io-label">Save to</div>
      <div className="export-folder">
        <Tooltip label={folder} side="top">
          <span className="export-folder-path">{shortPath(folder)}</span>
        </Tooltip>
        <button className="link-btn" onClick={onChange} disabled={disabled}>
          Change…
        </button>
      </div>
    </div>
  );
}

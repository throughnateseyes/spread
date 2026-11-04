/**
 * Spread's icon set — one place to import every UI icon from.
 *
 *   import { IconFrame, IconText } from '../ui/icons';
 *   <IconFrame />                  // 16px, Phosphor "regular" weight (toolbars, panel actions)
 *   <IconFrame size={ICON_DENSE} />  // 14px for dense rows (layers, field labels)
 *
 * Every export is a Phosphor-compatible `Icon` component (accepts size, weight, color, mirrored and
 * any SVG prop) whose defaults are tuned for the app: size 16, weight "regular", aria-hidden.
 * Phosphor's regular weight draws a 16/256 stroke, i.e. exactly 1px at 16px — crisp like Figma.
 *
 * A few glyphs Figma has but Phosphor lacks (upright frame "#", corner radius, gap, padding,
 * distribute, line height, letter spacing) are drawn here in Phosphor's grid (256 viewBox,
 * round caps, matching stroke weights) so they sit seamlessly next to the stock icons.
 */
import { createElement, forwardRef, type ReactElement } from 'react';
import {
  IconBase,
  type Icon,
  type IconProps,
  type IconWeight,
  AlignBottomIcon,
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AngleIcon,
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CircleNotchIcon,
  NotePencilIcon,
  PaperclipIcon,
  StopIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  BookmarkSimpleIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  ClipboardTextIcon,
  ColumnsIcon,
  CopyIcon,
  CopySimpleIcon,
  CornersOutIcon,
  CropIcon,
  CursorIcon,
  DeviceMobileIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  DropHalfIcon,
  EnvelopeSimpleIcon,
  ExportIcon,
  EyeIcon,
  EyeSlashIcon,
  FilePlusIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  FloppyDiskIcon,
  FolderOpenIcon,
  FrameCornersIcon,
  FolderSimpleIcon,
  HandIcon,
  HouseSimpleIcon,
  HeartIcon,
  ImageIcon,
  ImageSquareIcon,
  ImagesSquareIcon,
  InfoIcon,
  KeyboardIcon,
  LayoutIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  PlusIcon,
  RowsIcon,
  SlideshowIcon,
  FileTextIcon,
  SparkleIcon,
  SquareIcon,
  SunIcon,
  SquaresFourIcon,
  StackSimpleIcon,
  TextAaIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextTIcon,
  TextUnderlineIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
  ShuffleIcon,
  ArrowsLeftRightIcon,
} from '@phosphor-icons/react';

export type { Icon, IconProps, IconWeight };

/** Toolbar / panel action size. */
export const ICON = 16;
/** Dense rows: layer list, field labels, small icon buttons. */
export const ICON_DENSE = 14;

/** Wraps an icon so it defaults to 16px regular and is hidden from screen readers (buttons carry aria-label). */
function tuned(I: Icon, name: string): Icon {
  const C = forwardRef<SVGSVGElement, IconProps>((props, ref) =>
    createElement(I, { size: ICON, weight: 'regular', 'aria-hidden': props.alt ? undefined : true, focusable: 'false', ...props, ref } as IconProps),
  );
  C.displayName = name;
  return C as Icon;
}

// ---------- custom glyphs (Phosphor grid) ----------

const STROKE: Record<IconWeight, number> = { thin: 8, light: 12, regular: 16, bold: 24, fill: 16, duotone: 16 };

/** Builds an Icon from stroked SVG path data, in every Phosphor weight. */
function strokeIcon(name: string, d: string, extra?: (w: number) => ReactElement): Icon {
  const weights = new Map<IconWeight, ReactElement>(
    (Object.keys(STROKE) as IconWeight[]).map((w) => [
      w,
      createElement(
        'g',
        { fill: 'none', stroke: 'currentColor', strokeWidth: STROKE[w], strokeLinecap: 'round', strokeLinejoin: 'round' },
        createElement('path', { d }),
        extra?.(STROKE[w]),
      ),
    ]),
  );
  const C = forwardRef<SVGSVGElement, IconProps>((props, ref) => createElement(IconBase, { ...props, ref, weights }));
  C.displayName = name;
  return tuned(C as Icon, name);
}

const FrameGlyph = strokeIcon('IconFrame', 'M88,32V224M168,32V224M32,88H224M32,168H224');
const RadiusGlyph = strokeIcon('IconRadius', 'M48,208V120A72,72,0,0,1,120,48h88');
const GapHGlyph = strokeIcon('IconGapH', 'M40,48V208M216,48V208M104,128h48');
const GapVGlyph = strokeIcon('IconGapV', 'M48,40H208M48,216H208M128,104v48');
const PadHGlyph = strokeIcon('IconPaddingH', 'M48,40H208a8,8,0,0,1,8,8V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48A8,8,0,0,1,48,40ZM88,96v64M168,96v64');
const PadVGlyph = strokeIcon('IconPaddingV', 'M48,40H208a8,8,0,0,1,8,8V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48A8,8,0,0,1,48,40ZM96,88h64M96,168h64');
const DistHGlyph = strokeIcon('IconDistributeH', 'M40,40V216M216,40V216M112,72h32a8,8,0,0,1,8,8v96a8,8,0,0,1-8,8H112a8,8,0,0,1-8-8V80A8,8,0,0,1,112,72Z');
const DistVGlyph = strokeIcon('IconDistributeV', 'M40,40H216M40,216H216M72,112v32a8,8,0,0,0,8,8h96a8,8,0,0,0,8-8V112a8,8,0,0,0-8-8H80A8,8,0,0,0,72,112Z');
const LineHeightGlyph = strokeIcon('IconLineHeight', 'M40,40H216M40,216H216M88,184l40-104,40,104M103.4,144h49.2');
const LetterSpacingGlyph = strokeIcon('IconLetterSpacing', 'M40,40V216M216,40V216M88,184l40-104,40,104M103.4,144h49.2');

// ---------- tools ----------
export const IconMove = tuned(CursorIcon, 'IconMove');
export const IconHand = tuned(HandIcon, 'IconHand');
export const IconFrame = FrameGlyph;
export const IconPhotoFrame = tuned(ImageSquareIcon, 'IconPhotoFrame');
export const IconRect = tuned(SquareIcon, 'IconRect');
export const IconEllipse = tuned(CircleIcon, 'IconEllipse');
export const IconText = tuned(TextTIcon, 'IconText');
export const IconFonts = tuned(TextAaIcon, 'IconFonts');

// ---------- document / file ----------
export const IconNew = tuned(FilePlusIcon, 'IconNew');
export const IconOpen = tuned(FolderOpenIcon, 'IconOpen');
export const IconFolder = IconOpen;
export const IconFolderSimple = tuned(FolderSimpleIcon, 'IconFolderSimple');
export const IconHome = tuned(HouseSimpleIcon, 'IconHome');
export const IconSearch = tuned(MagnifyingGlassIcon, 'IconSearch');
export const IconSave = tuned(FloppyDiskIcon, 'IconSave');
export const IconUndo = tuned(ArrowUUpLeftIcon, 'IconUndo');
export const IconRedo = tuned(ArrowUUpRightIcon, 'IconRedo');
export const IconPreview = tuned(PlayIcon, 'IconPreview');
export const IconExport = tuned(ExportIcon, 'IconExport');
export const IconDownload = tuned(DownloadSimpleIcon, 'IconDownload');
export const IconUpload = tuned(UploadSimpleIcon, 'IconUpload');
export const IconKeyboard = tuned(KeyboardIcon, 'IconKeyboard');

// ---------- generic actions ----------
export const IconPlus = tuned(PlusIcon, 'IconPlus');
export const IconMinus = tuned(MinusIcon, 'IconMinus');
export const IconClose = tuned(XIcon, 'IconClose');
export const IconTrash = tuned(TrashIcon, 'IconTrash');
export const IconCheck = tuned(CheckIcon, 'IconCheck');
export const IconCheckCircle = tuned(CheckCircleIcon, 'IconCheckCircle');
export const IconReset = tuned(ArrowCounterClockwiseIcon, 'IconReset');
export const IconShuffle = tuned(ShuffleIcon, 'IconShuffle');
export const IconSwap = tuned(ArrowsLeftRightIcon, 'IconSwap');
export const IconCopy = tuned(CopyIcon, 'IconCopy');
export const IconDuplicate = tuned(CopySimpleIcon, 'IconDuplicate');
export const IconPaste = tuned(ClipboardTextIcon, 'IconPaste');
export const IconMore = tuned(DotsThreeIcon, 'IconMore');
export const IconInfo = tuned(InfoIcon, 'IconInfo');
export const IconWarning = tuned(WarningIcon, 'IconWarning');
export const IconSparkle = tuned(SparkleIcon, 'IconSparkle'); // Claude / automation

// ---------- Claude panel ----------
export const IconStop = tuned(StopIcon, 'IconStop');
export const IconAttach = tuned(PaperclipIcon, 'IconAttach');
export const IconSpinner = tuned(CircleNotchIcon, 'IconSpinner');
export const IconNewChat = tuned(NotePencilIcon, 'IconNewChat');
export const IconFile = tuned(FileTextIcon, 'IconFile');

// ---------- view ----------
export const IconZoomFit = tuned(CornersOutIcon, 'IconZoomFit');
export const IconZoomIn = tuned(MagnifyingGlassPlusIcon, 'IconZoomIn');
export const IconZoomOut = tuned(MagnifyingGlassMinusIcon, 'IconZoomOut');
export const IconEye = tuned(EyeIcon, 'IconEye');
export const IconEyeOff = tuned(EyeSlashIcon, 'IconEyeOff');
export const IconLock = tuned(LockSimpleIcon, 'IconLock');
export const IconUnlock = tuned(LockSimpleOpenIcon, 'IconUnlock');
export const IconChevronDown = tuned(CaretDownIcon, 'IconChevronDown');
export const IconChevronRight = tuned(CaretRightIcon, 'IconChevronRight');
export const IconChevronLeft = tuned(CaretLeftIcon, 'IconChevronLeft');
export const IconChevronUp = tuned(CaretUpIcon, 'IconChevronUp');

// ---------- panels / boards ----------
export const IconLayers = tuned(StackSimpleIcon, 'IconLayers');
export const IconPhotos = tuned(ImagesSquareIcon, 'IconPhotos');
export const IconImage = tuned(ImageIcon, 'IconImage');
export const IconArrange = tuned(SquaresFourIcon, 'IconArrange');
export const IconBoard = tuned(FrameCornersIcon, 'IconBoard');
export const IconCarousel = tuned(SlideshowIcon, 'IconCarousel');
export const IconPage = tuned(FileTextIcon, 'IconPage');
export const IconEmail = tuned(EnvelopeSimpleIcon, 'IconEmail');

// ---------- layout & alignment ----------
export const IconAlignLeft = tuned(AlignLeftIcon, 'IconAlignLeft');
export const IconAlignCenterH = tuned(AlignCenterHorizontalIcon, 'IconAlignCenterH');
export const IconAlignRight = tuned(AlignRightIcon, 'IconAlignRight');
export const IconAlignTop = tuned(AlignTopIcon, 'IconAlignTop');
export const IconAlignCenterV = tuned(AlignCenterVerticalIcon, 'IconAlignCenterV');
export const IconAlignBottom = tuned(AlignBottomIcon, 'IconAlignBottom');
export const IconDistributeH = DistHGlyph;
export const IconDistributeV = DistVGlyph;
/** Auto layout, horizontal (children side by side). */
export const IconAutoLayoutRow = tuned(ColumnsIcon, 'IconAutoLayoutRow');
/** Auto layout, vertical (children stacked). */
export const IconAutoLayoutColumn = tuned(RowsIcon, 'IconAutoLayoutColumn');
export const IconDirectionRow = tuned(ArrowRightIcon, 'IconDirectionRow');
export const IconDirectionColumn = tuned(ArrowDownIcon, 'IconDirectionColumn');
export const IconGapH = GapHGlyph;
export const IconGapV = GapVGlyph;
export const IconPaddingH = PadHGlyph;
export const IconPaddingV = PadVGlyph;
export const IconRadius = RadiusGlyph;
export const IconRotation = tuned(AngleIcon, 'IconRotation');
export const IconRotate = tuned(ArrowClockwiseIcon, 'IconRotate');
export const IconFlipH = tuned(FlipHorizontalIcon, 'IconFlipH');
export const IconFlipV = tuned(FlipVerticalIcon, 'IconFlipV');
export const IconCrop = tuned(CropIcon, 'IconCrop');
export const IconOpacity = tuned(DropHalfIcon, 'IconOpacity');

// ---------- typography ----------
export const IconTextAlignLeft = tuned(TextAlignLeftIcon, 'IconTextAlignLeft');
export const IconTextAlignCenter = tuned(TextAlignCenterIcon, 'IconTextAlignCenter');
export const IconTextAlignRight = tuned(TextAlignRightIcon, 'IconTextAlignRight');
export const IconTextAlignJustify = tuned(TextAlignJustifyIcon, 'IconTextAlignJustify');
export const IconBold = tuned(TextBIcon, 'IconBold');
export const IconItalic = tuned(TextItalicIcon, 'IconItalic');
export const IconUnderline = tuned(TextUnderlineIcon, 'IconUnderline');
export const IconStrikethrough = tuned(TextStrikethroughIcon, 'IconStrikethrough');
export const IconLetterCase = tuned(TextAaIcon, 'IconLetterCase');
export const IconLineHeight = LineHeightGlyph;
export const IconLetterSpacing = LetterSpacingGlyph;

// ---------- Instagram preview mock ----------
export const IconHeart = tuned(HeartIcon, 'IconHeart');
export const IconComment = tuned(ChatCircleIcon, 'IconComment');
export const IconShare = tuned(PaperPlaneTiltIcon, 'IconShare');
export const IconBookmark = tuned(BookmarkSimpleIcon, 'IconBookmark');

// ---------- navigation / email export ----------
export const IconArrowLeft = tuned(ArrowLeftIcon, 'IconArrowLeft');
export const IconArrowUp = tuned(ArrowUpIcon, 'IconArrowUp');
export const IconArrowDown = tuned(ArrowDownIcon, 'IconArrowDown');
export const IconLink = tuned(LinkSimpleIcon, 'IconLink');
export const IconDesktop = tuned(MonitorIcon, 'IconDesktop');
export const IconSun = tuned(SunIcon, 'IconSun');
export const IconMoon = tuned(MoonIcon, 'IconMoon');
export const IconMobile = tuned(DeviceMobileIcon, 'IconMobile');
export const IconLayout = tuned(LayoutIcon, 'IconLayout');

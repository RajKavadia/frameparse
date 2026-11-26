export type NodeType = "document" | "element" | "text";

export interface DomNodeBase {
  type: NodeType;
  nodeIndex: number;
  parent: DomDocument | DomElement | null;
}

export interface DomDocument extends DomNodeBase {
  type: "document";
  children: DomNode[];
}

export interface DomElement extends DomNodeBase {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  /** Assigned during Frame 1 pass: owning structure landmark ID (e.g. "s1") */
  structureId?: string;
  /** Assigned during Frame 3 pass: interactable ID (e.g. "i1") */
  interactableId?: string;
}

export interface DomText extends DomNodeBase {
  type: "text";
  value: string;
}

export type DomNode = DomDocument | DomElement | DomText;

export type FrameLayer = 1 | 2 | 3 | 4;

export interface ParseOptions {
  /** Base URL used to resolve relative links and form actions */
  url?: string;
  /** Which highest layer to build (default: 4) */
  maxLayer?: FrameLayer;
  /** Optional filter: restrict Frame 2/3/4 output to specific Frame 1 structure IDs */
  structureIds?: string[];
  /** Include hidden/aria-hidden elements (default: false) */
  includeHidden?: boolean;
  /** Minimum character length for standalone text blocks (default: 2) */
  minTextLength?: number;
}

// ============================================================================
// FRAME 1: STRUCTURE
// ============================================================================

export type LandmarkRole =
  | "document"
  | "header"
  | "nav"
  | "main"
  | "aside"
  | "footer"
  | "section"
  | "article"
  | "form"
  | "dialog"
  | "table"
  | "search"
  | "region";

export interface HeadingEntry {
  level: number;
  text: string;
  structureId: string;
}

export interface StructureStats {
  textBlocks: number;
  wordCount: number;
  interactables: number;
  forms: number;
  links: number;
  buttons: number;
  inputs: number;
}

export interface StructureNode {
  id: string;
  role: LandmarkRole;
  tag: string;
  label: string;
  parentId: string | null;
  depth: number;
  children: string[];
  headings: Array<{ level: number; text: string }>;
  stats: StructureStats;
  selector: string;
}

export interface PageMeta {
  url: string | null;
  title: string;
  lang: string | null;
  description: string | null;
  canonical: string | null;
  byteSize: number;
  parseMs: number;
  structureHash: string;
}

export interface FoldedLandmarkGroup {
  parentId: string;
  role: LandmarkRole;
  tag: string;
  count: number;
  firstId: string;
  lastId: string;
  sampleLabels: string[];
  avgTextBlocks: number;
  avgInteractables: number;
  memberIds: string[];
}

export interface StructureFrame {
  layer: 1;
  name: "structure";
  meta: PageMeta;
  landmarks: StructureNode[];
  outline: HeadingEntry[];
  foldedGroups?: FoldedLandmarkGroup[];
}

// ============================================================================
// FRAME 2: TEXT
// ============================================================================

export type TextBlockKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table_row"
  | "label"
  | "caption"
  | "blockquote"
  | "code"
  | "alert"
  | "metadata";

export interface TextBlock {
  id: string;
  structureId: string;
  kind: TextBlockKind;
  level?: number;
  text: string;
  wordCount: number;
  linkedInteractableIds?: string[];
}

export interface TextFrame {
  layer: 2;
  name: "text";
  totalBlocks: number;
  totalWords: number;
  blocks: TextBlock[];
}

// ============================================================================
// FRAME 3: INTERACTABLES
// ============================================================================

export type InteractableKind =
  | "link"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab"
  | "menuitem"
  | "summary"
  | "form";

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
}

export interface InteractableState {
  disabled: boolean;
  required: boolean;
  hidden: boolean;
  checked?: boolean;
  expanded?: boolean;
  readonly?: boolean;
  invalid?: boolean;
}

export interface InteractableElement {
  id: string;
  structureId: string;
  kind: InteractableKind;
  role: string;
  tag: string;
  name: string;
  inputType?: string;
  fieldName?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  formId?: string;
  options?: SelectOption[];
  constraints?: {
    minLength?: number;
    maxLength?: number;
    min?: string;
    max?: string;
    pattern?: string;
    accept?: string;
    multiple?: boolean;
  };
  state: InteractableState;
  selector: string;
  fallbackSelectors: string[];
}

export interface InteractableFrame {
  layer: 3;
  name: "interactables";
  totalInteractables: number;
  elements: InteractableElement[];
}

// ============================================================================
// FRAME 4: ACTIONS
// ============================================================================

export type ActionVerb =
  | "navigate"
  | "submit"
  | "fill"
  | "select"
  | "toggle"
  | "click"
  | "expand"
  | "download"
  | "focus";

export type ActionCategory =
  | "navigation"
  | "search"
  | "auth"
  | "form_submit"
  | "filter"
  | "pagination"
  | "commerce"
  | "crud_create"
  | "crud_delete"
  | "dismiss"
  | "media"
  | "download"
  | "general";

export type ActionEffect = "read" | "navigate" | "mutate" | "destructive";

export interface ActionParameter {
  interactableId: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  currentValue?: string;
  options?: string[];
  pattern?: string;
}

export interface ExecutionStep {
  op: "fill" | "select" | "toggle" | "click" | "submit" | "navigate";
  ref: string;
  selector: string;
  param?: string;
  value?: string;
  url?: string;
}

export interface ActionDestination {
  url: string;
  method?: string;
  isExternal: boolean;
  isAnchor: boolean;
  isDownload: boolean;
}

export interface ActionSpec {
  id: string;
  targetId: string;
  structureId: string;
  verb: ActionVerb;
  category: ActionCategory;
  effect: ActionEffect;
  isWorkflow: boolean;
  summary: string;
  preconditions: string[];
  parameters: ActionParameter[];
  steps: ExecutionStep[];
  destination?: ActionDestination;
  cachedOutcome?: CachedActionOutcome;
}

export interface CachedActionOutcome {
  origin: string;
  selector: string;
  hits: number;
  lastObservedAt: number;
  observedEffect: ActionEffect;
  summary: string;
  addedAlerts: string[];
  addedLandmarks: string[];
  removedLandmarks: string[];
}

export interface LiveDomNodeSnapshot {
  type: "element" | "text";
  tag?: string;
  attrs?: Record<string, string>;
  value?: string;
  children?: LiveDomNodeSnapshot[];
}

export interface LiveDomSnapshot {
  url: string;
  title?: string;
  root: LiveDomNodeSnapshot;
}

export interface ActionFrame {
  layer: 4;
  name: "actions";
  totalActions: number;
  totalWorkflows: number;
  actions: ActionSpec[];
  workflows: ActionSpec[];
}

// ============================================================================
// BUNDLE, PLANNER & DIFF
// ============================================================================

export interface TokenMetrics {
  rawHtmlBytes: number;
  estimatedRawTokens: number;
  frame1Tokens: number;
  frame2Tokens: number;
  frame3Tokens: number;
  frame4Tokens: number;
  totalFrameTokens: number;
  compressionRatio: number;
}

export interface ParsedPageFrames {
  frame1: StructureFrame;
  frame2?: TextFrame;
  frame3?: InteractableFrame;
  frame4?: ActionFrame;
  timingsMs: {
    htmlParse: number;
    frame1: number;
    frame2: number;
    frame3: number;
    frame4: number;
    total: number;
  };
  metrics: TokenMetrics;
}

export interface PlannedActionMatch {
  action: ActionSpec;
  score: number;
  matchedTokens: string[];
  reason: string;
}

export interface FrameDiff {
  structureChanged: boolean;
  addedLandmarks: string[];
  removedLandmarks: string[];
  addedTextBlocks: TextBlock[];
  removedTextBlockIds: string[];
  addedInteractables: InteractableElement[];
  removedInteractableIds: string[];
  changedInteractables: Array<{
    id: string;
    name: string;
    changes: Record<string, { before: unknown; after: unknown }>;
  }>;
  addedActions: ActionSpec[];
  removedActionIds: string[];
}

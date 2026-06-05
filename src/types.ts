export interface LinkRef {
  kind: "list" | "book";
  target_id: string;
  sub_id: string;
  label?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  has_spec: boolean;
  links?: LinkRef[];
  created_at: string;
  updated_at: string;
}

export interface DayEntry {
  date: string;
  todos: TodoItem[];
}

export interface Backlog {
  items: TodoItem[];
}

export interface MoveBacklogResult {
  backlog: Backlog;
  day: DayEntry;
}

export type FieldKind = "text" | "number" | "date" | "bool" | "select";

export interface ListField {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[] | null;
}

export interface TodoRef {
  date: string;
  todo_id: string;
  label?: string;
}

export interface ListItem {
  id: string;
  values: Record<string, unknown>;
  linked_todos: TodoRef[];
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface List {
  id: string;
  name: string;
  fields: ListField[];
  items: ListItem[];
  created_at: string;
  updated_at: string;
}

export interface ListSummary {
  id: string;
  name: string;
  updated_at: string;
}

export interface BookPage {
  id: string;
  title: string;
  order: number;
  linked_todos: TodoRef[];
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: string;
  name: string;
  pages: BookPage[];
  created_at: string;
  updated_at: string;
}

export interface BookSummary {
  id: string;
  name: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface Artifact {
  name: string;
  path: string;
  relative_path: string;
  size: number;
  created_at: string;
  is_dir: boolean;
}

export type ShaderBackground =
  | { type: "solid" }
  | {
      type: "meshGradient";
      colors: string[];
      distortion?: number;
      swirl?: number;
      speed?: number;
      grainOverlay?: number;
    }
  | {
      type: "waves";
      colorFront: string;
      colorBack: string;
      frequency?: number;
      amplitude?: number;
      spacing?: number;
      softness?: number;
      rotation?: number;
    }
  | {
      type: "dotOrbit";
      colorBack: string;
      colors: string[];
      size?: number;
      sizeRange?: number;
      spreading?: number;
      speed?: number;
    };

export interface Theme {
  name: string;
  label: string;
  colors: Record<string, string>;
  fonts: {
    body: string;
    mono: string;
  };
  background: ShaderBackground;
  backgroundOpacity?: number;
}

export type ViewTab = "day" | "week" | "month" | "backlog" | "lists" | "books" | "artifacts";

export type AgentStatus = "disconnected" | "starting" | "running" | "error" | "reconnecting";

export type AgentMode = "local" | "deployed" | "remote" | "p2p";

export interface VmInfo {
  name: string;
  status: string;
  backend: string;
}

export interface MigrationCounts {
  days: number;
  todos: number;
  backlog: number;
  lists: number;
  books: number;
  artifacts: number;
}

export interface MigrationStatsResult {
  local: MigrationCounts;
  sandbox: MigrationCounts;
}

export interface DeploymentInfo {
  mode: AgentMode;
  sandbox_id: string | null;
  public_url: string | null;
  p2p_ticket?: string | null;
  p2p_relay?: string | null;
}

export type SpecVerbosity = "terse" | "normal" | "detailed";

export interface AgentConfig {
  api_key: string;
  model: string;
  vm_name: string;
  vm_backend: string;
  data_dir: string;
  heyo_api_key: string;
  heyo_cloud_url: string;
  deploy_region: string;
  deploy_size_class: string;
  deploy_image: string;
  speech_api_key: string;
  spec_verbosity: SpecVerbosity;
  user_context: string;
  theme_name: string;
  llm_provider: "anthropic" | "openrouter";
  openrouter_api_key: string;
  openrouter_model: string;
}

export interface CalendarConfig {
  client_id: string;
  client_secret: string;
  enabled: boolean;
  calendar_id: string;
}

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  token_valid: boolean;
  enabled: boolean;
}

export interface CalendarEvent {
  summary: string;
  start_time: string;
  end_time: string;
}

export interface StatusInfo {
  agent_status: string;
  sandbox_status: string;
  sandbox_name: string;
  data_dir: string;
  data_dir_exists: boolean;
  heyvm_available: boolean;
  agent_error: string | null;
  sandbox_error: string | null;
  log_file: string;
  agent_mode: AgentMode;
  deploy_url: string | null;
}

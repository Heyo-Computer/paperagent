import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import { days, allArtifacts, allLists, allBooks } from "../../state/store";
import { useVoiceInput, voiceState, voiceError } from "../../hooks/useVoiceInput";
import { describeImage } from "../../api/commands";
import { SKILLS, type Skill } from "../../skills";
import type { TodoItem, Artifact, ListSummary, BookSummary } from "../../types";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

interface StagedImage {
  base64: string;     // raw base64 (no data URL prefix)
  mediaType: string;  // e.g. "image/png"
  dataUrl: string;    // full data URL for preview
  name: string;
}

function fileToBase64(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      resolve({ base64, dataUrl });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type MentionOption =
  | { kind: "todo"; key: string; label: string; sub: string; todo: TodoItem; date: string }
  | { kind: "artifact"; key: string; label: string; sub: string; artifact: Artifact }
  | { kind: "list"; key: string; label: string; sub: string; list: ListSummary }
  | { kind: "book"; key: string; label: string; sub: string; book: BookSummary };

interface ActiveMention {
  display: string; // visible text in the textarea, e.g. "@Buy groceries"
  token: string;   // agent-readable token, e.g. "@[Buy groceries](id:…|date:…)"
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentions, setMentions] = useState<ActiveMention[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillIndex, setSkillIndex] = useState(0);
  const [image, setImage] = useState<StagedImage | null>(null);
  const [imageError, setImageError] = useState<string>("");
  const [describing, setDescribing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  async function stageFile(file: File) {
    setImageError("");
    if (!file.type.startsWith("image/")) {
      setImageError(`'${file.name}' is not an image.`);
      return;
    }
    // Cap at ~10 MB to avoid huge payloads
    if (file.size > 10 * 1024 * 1024) {
      setImageError("Image is too large (max 10 MB).");
      return;
    }
    try {
      const { base64, dataUrl } = await fileToBase64(file);
      setImage({ base64, dataUrl, mediaType: file.type, name: file.name });
    } catch (e) {
      setImageError(`Failed to read image: ${e}`);
    }
  }

  function clearImage() {
    setImage(null);
    setImageError("");
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer && Array.from(e.dataTransfer.items ?? []).some((it) => it.kind === "file")) {
      setDragOver(true);
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await stageFile(file);
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          await stageFile(file);
          return;
        }
      }
    }
  }

  async function handleFilePick(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (file) await stageFile(file);
    target.value = "";
  }

  // Expand visible @label mentions into the agent-readable token on submit.
  function expandMentions(visible: string): string {
    let result = visible;
    // Sort by display length descending so longer labels match before substrings
    const sorted = [...mentions].sort((a, b) => b.display.length - a.display.length);
    for (const m of sorted) {
      result = result.split(m.display).join(m.token);
    }
    return result;
  }

  async function buildAndSend(visible: string) {
    if (!visible.trim() || disabled) return;
    let payload = expandMentions(visible.trim());

    if (image) {
      setDescribing(true);
      try {
        const description = await describeImage(image.base64, image.mediaType, visible.trim());
        payload = `${payload}\n\n[From the attached image (${image.name}):\n${description}\n]`;
      } catch (e) {
        setImageError(`Failed to read image: ${e}`);
        setDescribing(false);
        return;
      }
      setDescribing(false);
    }

    onSend(payload);
    setText("");
    setMentions([]);
    setImage(null);
    setImageError("");
    setShowMentions(false);
    setShowSkills(false);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }

  const handleTranscription = useCallback((transcribed: string) => {
    const visible = text.trim() ? text.trim() + " " + transcribed : transcribed;
    buildAndSend(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mentions, image, disabled, onSend]);

  const { toggle: toggleVoice } = useVoiceInput(handleTranscription);
  const vState = voiceState.value;
  const vError = voiceError.value;

  // Build the mention list: incomplete todos across loaded days, plus artifacts.
  function getMentionOptions(): MentionOption[] {
    const query = mentionQuery.toLowerCase();
    const options: MentionOption[] = [];
    for (const day of days.value) {
      for (const todo of day.todos) {
        if (todo.completed) continue;
        if (!query || todo.title.toLowerCase().includes(query)) {
          options.push({ kind: "todo", key: `todo:${todo.id}`, label: todo.title, sub: day.date, todo, date: day.date });
        }
      }
    }
    for (const artifact of allArtifacts.value) {
      const haystack = artifact.relative_path.toLowerCase();
      if (!query || haystack.includes(query)) {
        options.push({ kind: "artifact", key: `artifact:${artifact.relative_path}`, label: artifact.name, sub: artifact.relative_path, artifact });
      }
    }
    for (const list of allLists.value) {
      if (!query || list.name.toLowerCase().includes(query)) {
        options.push({ kind: "list", key: `list:${list.id}`, label: list.name, sub: "list", list });
      }
    }
    for (const book of allBooks.value) {
      if (!query || book.name.toLowerCase().includes(query)) {
        options.push({ kind: "book", key: `book:${book.id}`, label: book.name, sub: "book", book });
      }
    }
    return options;
  }

  const options = showMentions ? getMentionOptions() : [];

  const skillOptions: Skill[] = showSkills
    ? SKILLS.filter((s) => s.name.startsWith(skillQuery.toLowerCase()))
    : [];

  // Autocomplete the textarea to a literal "/name " prefix. Unlike mentions this
  // is NOT expanded into a hidden token — the agent reads the slash convention.
  function selectSkill(skill: Skill) {
    const newText = `/${skill.name} `;
    setText(newText);
    setShowSkills(false);
    setSkillQuery("");
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newText.length, newText.length);
      }
    });
  }

  function insertMention(opt: MentionOption) {
    // Find the @ trigger position
    const cursorPos = inputRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const atPos = beforeCursor.lastIndexOf("@");
    if (atPos === -1) return;

    const before = text.slice(0, atPos);
    const after = text.slice(cursorPos);
    const display = `@${opt.label}`;
    const token =
      opt.kind === "todo" ? `@[${opt.todo.title}](id:${opt.todo.id}|date:${opt.date})`
      : opt.kind === "artifact" ? `@[${opt.artifact.name}](artifact:${opt.artifact.relative_path})`
      : opt.kind === "list" ? `@[${opt.list.name}](list:${opt.list.id})`
      : `@[${opt.book.name}](book:${opt.book.id})`;
    const newText = before + display + " " + after;

    setText(newText);
    setMentions((prev) => [...prev, { display, token }]);
    setShowMentions(false);
    setMentionQuery("");

    // Refocus and set cursor after the mention
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + display.length + 1;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(pos, pos);
      }
    });
  }

  function handleSubmit() {
    buildAndSend(text);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (showSkills && skillOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillIndex((i) => Math.min(i + 1, skillOptions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSkill(skillOptions[skillIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkills(false);
        return;
      }
    }

    if (showMentions && options.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, options.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(options[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleInput(e: Event) {
    const target = e.currentTarget as HTMLTextAreaElement;
    const value = target.value;
    setText(value);
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 120) + "px";

    // Drop any mentions whose display text is no longer in the textarea
    setMentions((prev) => prev.filter((m) => value.includes(m.display)));

    const cursorPos = target.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursorPos);

    // Slash skill trigger: only at the very start of the message, while the caret
    // is still in the first token (no space yet). Mutually exclusive with @.
    const slashMatch = beforeCursor.match(/^\/(\S*)$/);
    if (slashMatch) {
      setSkillQuery(slashMatch[1]);
      setShowSkills(true);
      setSkillIndex(0);
      setShowMentions(false);
      return;
    }
    setShowSkills(false);

    // Check for @ trigger
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (showMentions && menuRef.current) {
      const item = menuRef.current.children[mentionIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex, showMentions]);

  useEffect(() => {
    if (showSkills && skillMenuRef.current) {
      const item = skillMenuRef.current.children[skillIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [skillIndex, showSkills]);

  // Close action menu when clicking outside
  useEffect(() => {
    if (!actionMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [actionMenuOpen]);

  function pickAttach() {
    setActionMenuOpen(false);
    fileInputRef.current?.click();
  }

  function pickVoice() {
    setActionMenuOpen(false);
    toggleVoice();
  }

  return (
    <>
      {vError && <div class="voice-error">{vError}</div>}
      {imageError && <div class="voice-error">{imageError}</div>}
      {image && (
        <div class="chat-image-preview">
          <img src={image.dataUrl} alt={image.name} class="chat-image-thumb" />
          <div class="chat-image-info">
            <div class="chat-image-name">{image.name}</div>
            <div class="chat-image-meta">{describing ? "Reading image..." : "Ready"}</div>
          </div>
          <button class="btn btn-sm btn-ghost" onClick={clearImage} title="Remove image">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <div
        class={`chat-input-area${dragOver ? " drag-over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {showSkills && skillOptions.length > 0 && (
          <div class="mention-menu" ref={skillMenuRef}>
            {skillOptions.map((skill, i) => (
              <div
                key={skill.name}
                class={`mention-item${i === skillIndex ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSkill(skill);
                }}
              >
                <span class="mention-kind mention-kind-skill">skill</span>
                <span class="mention-title">/{skill.name}</span>
                <span class="mention-date">{skill.hint}</span>
              </div>
            ))}
          </div>
        )}
        {showMentions && options.length > 0 && (
          <div class="mention-menu" ref={menuRef}>
            {options.map((opt, i) => (
              <div
                key={opt.key}
                class={`mention-item${i === mentionIndex ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(opt);
                }}
              >
                <span class={`mention-kind mention-kind-${opt.kind}`}>
                  {opt.kind === "todo" ? "todo"
                    : opt.kind === "list" ? "list"
                    : opt.kind === "book" ? "book"
                    : opt.artifact.is_dir ? "folder" : "file"}
                </span>
                <span class="mention-title">{opt.label}</span>
                <span class="mention-date">{opt.sub}</span>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFilePick}
        />
        <textarea
          ref={inputRef}
          class="chat-input"
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={image ? "Add a prompt for the image..." : "Message the agent... (@ to mention a todo or artifact)"}
          disabled={disabled || describing}
          rows={1}
        />
        <div class="chat-action-split" ref={actionMenuRef}>
          <button
            class={`btn btn-primary chat-action-main${vState === "recording" ? " recording" : ""}`}
            onClick={vState === "recording" ? toggleVoice : handleSubmit}
            disabled={
              disabled || describing ||
              (vState !== "recording" && vState !== "transcribing" && !text.trim() && !image)
            }
            title={
              vState === "recording" ? "Stop recording (Ctrl+H)" :
              vState === "transcribing" ? "Transcribing..." :
              describing ? "Reading image..." :
              "Send"
            }
          >
            {vState === "recording" ? "Stop" :
             vState === "transcribing" ? <span class="mic-spinner" /> :
             describing ? "Reading..." :
             "Send"}
          </button>
          <button
            class="btn btn-primary chat-action-carrot"
            onClick={() => setActionMenuOpen((o) => !o)}
            disabled={disabled || describing || vState === "transcribing"}
            title="More actions"
            aria-label="More actions"
          >
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
          {actionMenuOpen && (
            <div class="chat-action-menu">
              <button class="chat-action-menu-item" onMouseDown={(e) => { e.preventDefault(); pickAttach(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span>Attach image</span>
              </button>
              <button class="chat-action-menu-item" onMouseDown={(e) => { e.preventDefault(); pickVoice(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                <span>Voice input</span>
                <span class="chat-action-menu-shortcut">Ctrl+H</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

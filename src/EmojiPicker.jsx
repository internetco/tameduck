import React, { useState } from "react";
import { Search } from "lucide-react";

const emojis = [
  ["🦆", "Duck"],
  ["🦉", "Owl"],
  ["🎨", "Artist palette"],
  ["📊", "Bar chart"],
  ["🛠️", "Tools"],
  ["✍️", "Writing hand"],
  ["🔎", "Magnifying glass"],
  ["💡", "Light bulb"],
  ["🐱", "Cat"],
  ["🐶", "Dog"],
  ["🦊", "Fox"],
  ["🐼", "Panda"],
  ["🦁", "Lion"],
  ["🐯", "Tiger"],
  ["🐸", "Frog"],
  ["🐧", "Penguin"],
  ["🦄", "Unicorn"],
  ["🐝", "Bee"],
  ["🦋", "Butterfly"],
  ["🐙", "Octopus"],
  ["🤖", "Robot"],
  ["🖥️", "Desktop computer"],
  ["💻", "Laptop"],
  ["⌨️", "Keyboard"],
  ["⚙️", "Gear"],
  ["🧠", "Brain"],
  ["🔬", "Microscope"],
  ["🔭", "Telescope"],
  ["🛰️", "Satellite"],
  ["🚀", "Rocket"],
  ["🌍", "Globe"],
  ["🛡️", "Shield"],
  ["💼", "Briefcase"],
  ["📋", "Clipboard"],
  ["📚", "Books"],
  ["📓", "Notebook"],
  ["📝", "Memo"],
  ["📅", "Calendar"],
  ["🎯", "Target"],
  ["🏆", "Trophy"],
  ["🏅", "Medal"],
  ["👑", "Crown"],
  ["💎", "Gem"],
  ["💰", "Money bag"],
  ["📷", "Camera"],
  ["🎥", "Movie camera"],
  ["🎤", "Microphone"],
  ["🎧", "Headphones"],
  ["🎸", "Guitar"],
  ["🎺", "Trumpet"],
  ["🥁", "Drum"],
  ["🎵", "Musical note"],
  ["🖌️", "Paintbrush"],
  ["🧵", "Thread"],
  ["☀️", "Sun"],
  ["🌈", "Rainbow"],
  ["🔥", "Fire"],
  ["⚡", "Lightning"],
  ["⭐", "Star"],
  ["✨", "Sparkles"],
  ["🎉", "Party popper"],
  ["🎈", "Balloon"],
  ["☕", "Coffee"],
  ["🍕", "Pizza"],
];

export function EmojiPicker({ value, disabled, onChange }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const choices = emojis.filter(([emoji, name]) =>
    (emoji + " " + name.toLocaleLowerCase()).includes(query),
  );
  return (
    <div className="duck-emoji-picker">
      <div className="emoji-picker-toolbar">
        <div className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search emojis"
            placeholder="Search emojis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span aria-live="polite">
          {choices.length} {choices.length === 1 ? "emoji" : "emojis"}
        </span>
      </div>
      <div className="emoji-options" role="group" aria-label="Emoji avatars">
        {choices.map(([emoji, name]) => (
          <button
            type="button"
            disabled={disabled}
            aria-label={"Choose " + name + " emoji"}
            aria-pressed={value === emoji}
            title={name}
            key={emoji}
            className={value === emoji ? "selected" : ""}
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
        {!choices.length && (
          <p className="emoji-picker-empty">
            No emojis found. Try another name.
          </p>
        )}
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { Search, MessageSquare, ArrowRight, Users } from "lucide-react";
import { api, Avatar, Modal, Empty } from "./ui.jsx";
export default function DirectMessagePicker({
  data,
  action,
  onCreated,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const people = data.members.filter(
    (m) =>
      m.id !== data.user.id &&
      (m.name + " " + m.email).toLowerCase().includes(query.toLowerCase()),
  );
  async function open(person) {
    setBusy(person.id);
    setError("");
    const conv = await action(async () => {
      try {
        return await api("/conversations/direct", "POST", {
          user_id: person.id,
        });
      } catch (e) {
        setError(e.message);
        throw e;
      }
    });
    setBusy(null);
    if (conv) onCreated(conv);
  }
  return (
    <Modal title="Message a teammate" onClose={onClose}>
      <p>Start a private conversation with someone in {data.company.name}.</p>
      <div className="search-field">
        <Search size={17} />
        <input
          autoFocus
          aria-label="Find a teammate"
          placeholder="Search by name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && (
        <p className="direct-error" role="alert">
          {error}
        </p>
      )}
      <div className="direct-picker-list">
        {people.map((m) => (
          <button key={m.id} onClick={() => open(m)} disabled={!!busy}>
            <Avatar name={m.name} />
            <span>
              <strong>{m.name}</strong>
              <small>{busy === m.id ? "Opening conversation…" : m.email}</small>
            </span>
            <ArrowRight size={17} />
          </button>
        ))}
      </div>
      {!people.length && (
        <Empty
          icon={Users}
          title={
            query ? "No teammates found" : "Your teammates will appear here"
          }
        >
          {query
            ? "Try another name or email."
            : "Invite someone from the Team page to start chatting together."}
        </Empty>
      )}
    </Modal>
  );
}

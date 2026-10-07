export function conversationPeer(conversation, data) {
  return data.members.find(
    (m) => m.id !== data.user.id && conversation?.members.includes(m.id),
  );
}
export function conversationName(conversation, data) {
  if (!conversation) return "Your conversations";
  if (conversation.kind === "human")
    return conversationPeer(conversation, data)?.name || "Former teammate";
  if (conversation.kind === "group") return conversation.name;
  return (
    data.ducks.find((d) => conversation.ducks.includes(d.id))?.name ||
    conversation.name
  );
}

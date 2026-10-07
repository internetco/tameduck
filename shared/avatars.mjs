export const duckAvatars = [
  {
    id: "01-hype-duck",
    name: "Hype Duck",
  },
  {
    id: "02-royal-duck",
    name: "Royal Duck",
  },
  {
    id: "03-disco-duck",
    name: "Disco Duck",
  },
  {
    id: "04-space-duck",
    name: "Space Duck",
  },
  {
    id: "05-pirate-duck",
    name: "Pirate Duck",
  },
  {
    id: "06-punk-duck",
    name: "Punk Duck",
  },
  {
    id: "07-chef-duck",
    name: "Chef Duck",
  },
  {
    id: "08-detective-duck",
    name: "Detective Duck",
  },
  {
    id: "09-dj-duck",
    name: "DJ Duck",
  },
  {
    id: "10-cowboy-duck",
    name: "Cowboy Duck",
  },
  {
    id: "11-diva-duck",
    name: "Diva Duck",
  },
  {
    id: "12-wizard-duck",
    name: "Wizard Duck",
  },
  {
    id: "13-builder-duck",
    name: "Builder Duck",
  },
  {
    id: "14-dragon-duck",
    name: "Dragon Duck",
  },
  {
    id: "15-viking-duck",
    name: "Viking Duck",
  },
  {
    id: "16-sport-duck",
    name: "Sport Duck",
  },
  {
    id: "17-artist-duck",
    name: "Artist Duck",
  },
  {
    id: "18-hacker-duck",
    name: "Hacker Duck",
  },
  {
    id: "19-vacation-duck",
    name: "Vacation Duck",
  },
  {
    id: "20-business-duck",
    name: "Business Duck",
  },
];
export const avatarIds = duckAvatars.map((a) => a.id);
export function avatarFor(duck) {
  if (duck?.avatar === "emoji") return null;
  return avatarIds.includes(duck?.avatar)
    ? duck.avatar
    : duck?.chief
      ? "02-royal-duck"
      : "01-hype-duck";
}

export function avatarImage(avatar, size = 128) {
  return `/avatars/transparent-v1/${avatar}-${size}.webp`;
}

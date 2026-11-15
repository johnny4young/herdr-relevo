// The Spaces list paints its folders with this palette, so a folder mark here matches the sidebar.
export const FOLDER_COLORS = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const folderColor = (color, fallback) => (color ? FOLDER_COLORS[color] ?? color : fallback);

export function formatToday(date = new Date()): string {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Formats a date with a simple pattern: yyyy, yy, mmmm, mmm, mm, m, dd, d. */
export function formatDatePattern(date: Date, pattern: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (tok) => {
    switch (tok) {
      case "yyyy":
        return String(date.getFullYear());
      case "yy":
        return String(date.getFullYear()).slice(-2);
      case "mmmm":
        return months[date.getMonth()];
      case "mmm":
        return months[date.getMonth()].slice(0, 3);
      case "mm":
        return pad(date.getMonth() + 1);
      case "m":
        return String(date.getMonth() + 1);
      case "dd":
        return pad(date.getDate());
      case "d":
        return String(date.getDate());
    }
    return tok;
  });
}

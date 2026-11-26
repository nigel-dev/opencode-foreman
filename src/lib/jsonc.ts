/** Removes comments and trailing commas so a JSONC document can go through `JSON.parse`. */
export function stripJsonc(source: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
    } else if (char === '"') {
      inString = true;
      output += char;
      index++;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === ",") {
      const rest = source.slice(index + 1).replace(/^(\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, "");
      if (!rest.startsWith("}") && !rest.startsWith("]")) output += char;
      index++;
    } else {
      output += char;
      index++;
    }
  }
  return output;
}

export function parseJsonc(source: string): unknown {
  return JSON.parse(stripJsonc(source));
}

/** Detect blank lines inside executable JavaScript and TypeScript blocks. */

export function executableBlockBlankLines(source) {
  const lines = source.split(/\r?\n/u);
  const blanks = [];
  const stack = [];
  let blockComment = false;
  let currentExecutableDepth = 0;
  let previousCode = "";
  let quote;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (
      /^\s*$/u.test(line) &&
      currentExecutableDepth > 0 &&
      quote !== "`"
    )
      blanks.push(lineIndex + 1);
    let code = "";
    let regularExpression = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (regularExpression) {
        if (char === "\\") index += 1;
        else if (char === "/") regularExpression = false;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") break;
      if (
        char === "/" &&
        /^(?:|.*(?:[=(,:;!&|?{}]|\b(?:return|case|throw)))\s*$/u.test(code)
      ) {
        regularExpression = true;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        const prefix = code.trimEnd() || previousCode;
        const executable =
          /\)\s*$|=>\s*$|\b(?:else|try|finally|do)\s*$/u.test(prefix);
        stack.push(executable);
        if (executable) currentExecutableDepth += 1;
      } else if (char === "}") {
        if (stack.pop()) currentExecutableDepth -= 1;
      }
      code += char;
    }
    if (quote !== "`") quote = undefined;
    if (code.trim()) previousCode = code.trim();
  }
  return blanks;
}

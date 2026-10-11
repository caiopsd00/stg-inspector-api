// The supplied Word template contained a previous machine's example findings.
// Remove only those literals BEFORE inserting user data; keep limits, codes,
// official table layout and all recorded observations intact.
export const neutralInspectionNames: Record<string, string> = {
  "086": "Indicação de pressão das patolas",
  "087": "Alinhamento do nível de bolha e nível eletrônico",
  "126": "Cabo de aço do guincho principal",
  "127": "Cabo de aço do guincho auxiliar",
  "148": "Indicação de ângulo da lança telescópica",
  "150": "Indicação de raio",
  "152": "0° — medição da folga axial",
  "153": "90° — medição da folga axial",
  "154": "180° — medição da folga axial",
  "155": "270° — medição da folga axial",
};

export function cleanInspectionTemplateXml(xml: string): string {
  const measurementExamples = new Set([
    "-0,6 Graus",
    "0 Graus",
    "44,20 Graus",
    "45 Graus",
    "69,10 Graus",
    "70 Graus",
    "8,5 Metros",
    "8 Metros",
    "15,4 Metros",
    "15 Metros",
    "22,3 Metros",
    "22 Metros",
  ]);
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join("");
    const code = /\{\{o_(\d+)\}\}/.exec(text)?.[1];
    let replacement: string | undefined;
    if (code && neutralInspectionNames[code]) {
      replacement = `${neutralInspectionNames[code]} {{o_${code}}}`;
      if (code === "126" || code === "127")
        replacement = `Diâmetro / laudo: registrar nas observações. {{o_${code}}}`;
    } else if (text.includes("LAUDO MALURE"))
      replacement = neutralInspectionNames["126"];
    else if (measurementExamples.has(text.trim()))
      replacement = "Ver observações do item";
    if (replacement === undefined) return paragraph;
    let first = true;
    return paragraph.replace(
      /(<w:t\b[^>]*>)[\s\S]*?<\/w:t>/g,
      (_, open: string) => {
        const value = first ? replacement : "";
        first = false;
        return `${open}${value}</w:t>`;
      },
    );
  });
}

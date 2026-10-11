import { InspectionSection } from "./types";
import { neutralInspectionNames } from "./inspection-template-cleanup";

export type TemplateDocumentField = {
  key: string;
  label: string;
  defaultValue?: string;
};

export type TemplateImageSlot = {
  key: string;
  label: string;
};

export type TemplateInspectionItem = {
  id: string;
  code: string;
  name: string;
  extraImageSlots?: string[];
};

export type TemplateInspectionSection = {
  id: string;
  name: string;
  items: TemplateInspectionItem[];
};

export const documentFields: TemplateDocumentField[] = [
  { key: "000", label: "Inspeção número" },
  { key: "001", label: "Guindaste" },
  { key: "002", label: "MODELO DO GUINDASTE" },
  { key: "003", label: "NÚMERO DE SÉRIE" },
  { key: "004", label: "CAPACIDADE NOMINAL" },
  { key: "005", label: "ANO" },
  { key: "006", label: "HORÍMETRO" },
  { key: "007", label: "QUILOMETRAGEM*" },
  { key: "008", label: "N° da PLACA / FROTA" },
  { key: "009", label: "EXAMINADOR" },
  { key: "010", label: "DATA DE VISTORIA" },
  { key: "011", label: "RESULTADO DA VISTORIA" },
  { key: "012", label: "PRÓXIMA VISTORIA" },
  { key: "164", label: "Inspeção realizada por" },
  { key: "165", label: "Inspeção aprovada por" },
];

export function normalizeInspectionResult(
  value: string,
): "Aprovada" | "Rejeitada" | "" {
  if (
    value === "Aprovada" ||
    value === "Aprovado" ||
    value === "Aprovado com recomendações"
  )
    return "Aprovada";
  if (value === "Rejeitada" || value === "Não aprovado") return "Rejeitada";
  return "";
}

export const documentImageSlots: TemplateImageSlot[] = [
  { key: "013", label: "Fotografia do equipamento" },
  { key: "014", label: "Dados técnicos do equipamento" },
];

export const templateInspectionSections: TemplateInspectionSection[] = [
  {
    id: "inspe-o-do-equipamento",
    name: "INSPEÇÃO DO EQUIPAMENTO",
    items: [
      { id: "item-015", code: "015", name: "Registro de inspeção diária" },
      {
        id: "item-016",
        code: "016",
        name: "Registro de lubrificação e manutenção",
      },
      {
        id: "item-017",
        code: "017",
        name: "Manual e instruções técnicas do fabricante do guindaste",
      },
    ],
  },
  {
    id: "plataforma-inferior-conjunto-mec-nico",
    name: "Plataforma Inferior – Conjunto Mecânico",
    items: [
      { id: "item-018", code: "018", name: "Eixos" },
      { id: "item-019", code: "019", name: "Rodas e pneus" },
      {
        id: "item-020",
        code: "020",
        name: "Caixa de transmissão e distribuição",
      },
      { id: "item-021", code: "021", name: "Cardans" },
      { id: "item-022", code: "022", name: "Cubos de roda" },
      {
        id: "item-023",
        code: "023",
        name: "Freios – Funcionamento e desgaste",
      },
      { id: "item-024", code: "024", name: "Sistema de direção" },
      { id: "item-025", code: "025", name: "Suspensão" },
      { id: "item-026", code: "026", name: "Funcionamento do motor" },
      {
        id: "item-027",
        code: "027",
        name: "Sistema de escape / proteção contra faíscas",
      },
      { id: "item-028", code: "028", name: "Suportes do motor e transmissão" },
      { id: "item-029", code: "029", name: "Tanque de combustível / Boia" },
      { id: "item-030", code: "030", name: "Freio motor" },
      { id: "item-031", code: "031", name: "Filtro de ar" },
    ],
  },
  {
    id: "chassis-cabine-e-acess-rios",
    name: "Chassis, cabine e acessórios",
    items: [
      { id: "item-032", code: "032", name: "Escadas de acesso" },
      { id: "item-033", code: "033", name: "Apoios dos contrapesos – Berço" },
      { id: "item-034", code: "034", name: "Apoio do moitão" },
      { id: "item-035", code: "035", name: "Apoio da lança – cavalete" },
      { id: "item-036", code: "036", name: "Portas e Maçanetas" },
      { id: "item-037", code: "037", name: "Janelas/Vidros" },
      { id: "item-038", code: "038", name: "Limpadores de para-brisas" },
      { id: "item-039", code: "039", name: "Espelhos" },
      { id: "item-040", code: "040", name: "Bancos e ajuste do operador" },
      { id: "item-041", code: "041", name: "Ventilação e ar condicionado" },
      { id: "item-042", code: "042", name: "Estado geral do chassis inferior" },
      { id: "item-043", code: "043", name: "Patolas e sapatas de patolamento" },
      {
        id: "item-044",
        code: "044",
        name: "Pinos Travamento de viga de patola",
      },
      { id: "item-045", code: "045", name: "Chave de ignição" },
      { id: "item-046", code: "046", name: "Tampas e coberturas" },
      { id: "item-047", code: "047", name: "Manômetros de controle" },
      { id: "item-048", code: "048", name: "Funilaria e Pintura" },
    ],
  },
  {
    id: "plataforma-inferior-sistema-hidr-ulico",
    name: "Plataforma Inferior – Sistema Hidráulico",
    items: [
      { id: "item-049", code: "049", name: "Tanque de óleo hidráulico" },
      {
        id: "item-050",
        code: "050",
        name: "Filtro de retorno / Respiro do tanque",
      },
      { id: "item-051", code: "051", name: "Bombas hidráulicas" },
      { id: "item-052", code: "052", name: "Válvulas" },
      { id: "item-053", code: "053", name: "Mangueiras" },
      { id: "item-054", code: "054", name: "Cilindros" },
    ],
  },
  {
    id: "plataforma-inferior-sistema-pneum-tico",
    name: "Plataforma Inferior – Sistema Pneumático",
    items: [
      { id: "item-055", code: "055", name: "Compressor de Ar" },
      { id: "item-056", code: "056", name: "Filtro desumificador" },
      { id: "item-057", code: "057", name: "Reservatórios de ar" },
      { id: "item-058", code: "058", name: "Válvulas" },
      { id: "item-059", code: "059", name: "Condutores" },
      { id: "item-060", code: "060", name: "Mangueiras" },
      { id: "item-061", code: "061", name: "Cilindros" },
      { id: "item-062", code: "062", name: "Presença de vazamentos" },
    ],
  },
  {
    id: "plataforma-inferior-sistema-el-trico",
    name: "Plataforma Inferior – Sistema Elétrico",
    items: [
      { id: "item-063", code: "063", name: "Alternador" },
      { id: "item-064", code: "064", name: "Bateria" },
      { id: "item-065", code: "065", name: "Fusíveis" },
      { id: "item-066", code: "066", name: "Farol e lanternas" },
      { id: "item-067", code: "067", name: "Luz de patolamento" },
      { id: "item-068", code: "068", name: "Setas" },
      { id: "item-069", code: "069", name: "Giroflex" },
      { id: "item-070", code: "070", name: "Luz de ré" },
      { id: "item-071", code: "071", name: "Luz de freio" },
      { id: "item-072", code: "072", name: "Indicações do painel" },
      { id: "item-073", code: "073", name: "Conta-giros e velocímetro" },
      { id: "item-074", code: "074", name: "Motor de arranque" },
      { id: "item-075", code: "075", name: "Extintor de incêndio" },
      { id: "item-076", code: "076", name: "Erro elétrico Ativo" },
    ],
  },
  {
    id: "plataforma-inferior-teste-e-opera-o-das-fun-es",
    name: "Plataforma Inferior - Teste e operação das funções",
    items: [
      {
        id: "item-077",
        code: "077",
        name: "Funcionamento da suspensão e nivelamento",
      },
      { id: "item-078", code: "078", name: "Funcionamento da Tração" },
      {
        id: "item-079",
        code: "079",
        name: "Funcionamento do bloqueio dos eixos",
      },
      { id: "item-080", code: "080", name: "Modos de direção e caranguejo" },
      { id: "item-081", code: "081", name: "Suspender eixo central" },
      { id: "item-082", code: "082", name: "Marcha para todo terreno" },
      {
        id: "item-083",
        code: "083",
        name: "Bloqueio e retenção da suspensão - Eixos",
      },
      { id: "item-084", code: "084", name: "Embreagem deslizante - Lesma" },
      { id: "item-085", code: "085", name: "Funcionamento das patolas" },
      {
        id: "item-086",
        code: "086",
        name: "Indicação de pressão das patolas (INDICAÇÃO DE PRESSÁO DAS PATOLAS DIANTEIRAS ESQ. E DIR. INOPERANTE)",
      },
      {
        id: "item-087",
        code: "087",
        name: "Alinhamento do nível de bolha e nível eletrônico (NIVEIS DESCALIBRADOS)",
      },
    ],
  },
  {
    id: "plataforma-superior-conjunto-mec-nico",
    name: "Plataforma Superior - Conjunto Mecânico",
    items: [
      { id: "item-088", code: "088", name: "Funcionamento do motor" },
      {
        id: "item-089",
        code: "089",
        name: "Sistema de escape / Proteção contra faíscas",
      },
      { id: "item-090", code: "090", name: "Suportes do motor e transmissão" },
      { id: "item-091", code: "091", name: "Tanque de combustível / Boia" },
      { id: "item-092", code: "092", name: "Níveis de óleo / água" },
      { id: "item-093", code: "093", name: "Filtro e tubos de combustível" },
      { id: "item-094", code: "094", name: "Filtro de ar" },
    ],
  },
  {
    id: "plataforma-superior-chassis-cabine-e-acess-rios",
    name: "Plataforma Superior - Chassis, Cabine e Acessórios.",
    items: [
      {
        id: "item-095",
        code: "095",
        name: "Escadas de acesso e plataforma de apoio da cabine",
      },
      { id: "item-096", code: "096", name: "Portas e Maçanetas" },
      { id: "item-097", code: "097", name: "Vidro frontal" },
      { id: "item-098", code: "098", name: "Vidro de teto" },
      {
        id: "item-099",
        code: "099",
        name: "Tampas, coberturas e amortecedores",
      },
      { id: "item-100", code: "100", name: "Limpadores de para-brisas" },
      { id: "item-101", code: "101", name: "Espelhos / Câmeras" },
      { id: "item-102", code: "102", name: "Bancos e ajustes do operador" },
      { id: "item-103", code: "103", name: "Ventilação e Ar Condicionado" },
      { id: "item-104", code: "104", name: "Estado geral do chassis superior" },
      { id: "item-105", code: "105", name: "Chave de ignição" },
      { id: "item-106", code: "106", name: "Manômetros de controle" },
      { id: "item-107", code: "107", name: "Contrapesos" },
      { id: "item-108", code: "108", name: "Funilaria e Pintura" },
    ],
  },
  {
    id: "plataforma-superior-sistema-hidr-ulico",
    name: "Plataforma Superior - Sistema Hidráulico",
    items: [
      { id: "item-109", code: "109", name: "Tanque de óleo hidráulico" },
      {
        id: "item-110",
        code: "110",
        name: "Filtro de retorno / Respiro do tanque",
      },
      { id: "item-111", code: "111", name: "Bombas hidráulicas" },
      { id: "item-112", code: "112", name: "Válvulas" },
      { id: "item-113", code: "113", name: "Mangueiras" },
      { id: "item-114", code: "114", name: "Cilindros Contra Peso" },
      { id: "item-115", code: "115", name: "Cilindro Telescopagem" },
      { id: "item-116", code: "116", name: "Cilindro de Basculamento" },
    ],
  },
  {
    id: "plataforma-superior-sistema-el-trico",
    name: "Plataforma Superior - Sistema Elétrico",
    items: [
      { id: "item-117", code: "117", name: "Alternador" },
      { id: "item-118", code: "118", name: "Bateria" },
      { id: "item-119", code: "119", name: "Fusíveis" },
      { id: "item-120", code: "120", name: "Farol e lanternas" },
      { id: "item-121", code: "121", name: "Luzes de operação" },
      { id: "item-122", code: "122", name: "Farol direcionável da lança" },
      { id: "item-123", code: "123", name: "Giroflex" },
      { id: "item-124", code: "124", name: "Indicações do painel" },
      { id: "item-125", code: "125", name: "Motor de arranque" },
    ],
  },
  {
    id: "plataforma-superior-acess-rios-de-i-amento",
    name: "Plataforma Superior – Acessórios de içamento",
    items: [
      {
        id: "item-126",
        code: "126",
        name: "Cabo de aço do guincho principal - LAUDO MALURE – ML-32021110-LTM1090 Diâmetro Nominal 19mm",
        extraImageSlots: ["126_1"],
      },
      {
        id: "item-127",
        code: "127",
        name: "Cabo de aço do guincho auxiliar. Diâmetro Nominal 17 MM",
        extraImageSlots: ["127_1"],
      },
      { id: "item-128", code: "128", name: "Roletes da lança" },
      { id: "item-129", code: "129", name: "Roldanas da ponta da lança" },
      { id: "item-130", code: "130", name: "Moitão principal" },
      { id: "item-131", code: "131", name: "Moitão auxiliar" },
      {
        id: "item-132",
        code: "132",
        name: "Jib // Boom Nose // Luffing // TA-TY",
      },
    ],
  },
  {
    id: "plataforma-superior-teste-e-opera-o-das-fun-es",
    name: "Plataforma Superior – Teste e operação das funções",
    items: [
      { id: "item-133", code: "133", name: "Funcionamento do PAT" },
      {
        id: "item-134",
        code: "134",
        name: "Funcionamento da lança telescópica",
      },
      {
        id: "item-135",
        code: "135",
        name: "Funcionamento do sistema de pinagem",
      },
      {
        id: "item-136",
        code: "136",
        name: "Funcionamento do guincho principal",
      },
      {
        id: "item-137",
        code: "137",
        name: "Funcionamento do guincho auxiliar",
      },
      {
        id: "item-138",
        code: "138",
        name: "Funcionamento da elevação da lança",
      },
      { id: "item-139", code: "139", name: "Funcionamento do giro" },
      { id: "item-140", code: "140", name: "Funcionamento do freio de giro" },
      { id: "item-141", code: "141", name: "Funcionamento do pino de giro" },
      {
        id: "item-142",
        code: "142",
        name: "Funcionamento da inclinação da cabine",
      },
      {
        id: "item-143",
        code: "143",
        name: "Funcionamento do fim de curso do guincho principal",
      },
      {
        id: "item-144",
        code: "144",
        name: "Funcionamento do fim de curso do guincho auxiliar",
      },
      { id: "item-145", code: "145", name: "Funcionamento do anemômetro" },
      {
        id: "item-146",
        code: "146",
        name: "Montagem automática do contrapeso",
      },
      { id: "item-147", code: "147", name: "Erros elétricos ativos" },
    ],
  },
  {
    id: "plataforma-superior-testes-e-medi-es",
    name: "Plataforma Superior - Testes e medições",
    items: [
      {
        id: "item-148",
        code: "148",
        name: "Indicação de ângulo da lança telescópica (CALIBRAR ÂNGULO)",
        extraImageSlots: ["148_1"],
      },
      {
        id: "item-149",
        code: "149",
        name: "Indicação de comprimento de lança",
      },
      {
        id: "item-150",
        code: "150",
        name: "Indicação de raio (CALIBRAR RAIO)",
        extraImageSlots: ["150_1"],
      },
      {
        id: "item-151",
        code: "151",
        name: "Funcionamento da indicação do contrapeso",
      },
    ],
  },
  {
    id: "folga-axial-coroa-giro",
    name: "FOLGA AXIAL COROA GIRO",
    items: [
      { id: "item-152", code: "152", name: "0° - 0,5mm" },
      { id: "item-153", code: "153", name: "90° - 0,14mm" },
      { id: "item-154", code: "154", name: "180° - 0,07mm" },
      { id: "item-155", code: "155", name: "270° - 0,03mm" },
    ],
  },
];

for (const section of templateInspectionSections)
  for (const item of section.items)
    item.name = neutralInspectionNames[item.code] || item.name;

export function createTemplateSections(): InspectionSection[] {
  return templateInspectionSections.map((section) => ({
    id: section.id,
    name: section.name,
    items: section.items.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      observation: "",
      images: [],
      extraImageSlots: item.extraImageSlots,
    })),
  }));
}

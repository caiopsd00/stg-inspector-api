export type ItemSituation = "A" | "B" | "C" | "D";

export type InspectionImage = {
  id: string;
  uri: string;
  name: string;
  createdAt: string;
  height?: number;
  width?: number;
};

export type InspectionItem = {
  id: string;
  code: string;
  name: string;
  situation?: ItemSituation;
  observation: string;
  images: InspectionImage[];
  extraImageSlots?: string[];
  updatedAt?: string;
};

export type InspectionSection = {
  id: string;
  name: string;
  items: InspectionItem[];
};

export type Inspection = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  documentFields: Record<string, string>;
  documentImages: Record<string, InspectionImage[]>;
  sections: InspectionSection[];
  clientSnapshot?: { name: string; identifier: string } | null;
  technicianSnapshot?: { name: string; identifier: string } | null;
  technicianSignature?: InspectionImage;
  clientSignature?: InspectionImage;
  signature?: InspectionImage;
  signatureUri?: string;
  signatureDataUrl?: string;
  finalizedAt?: string;
  finalJsonUri?: string;
};

export type InspectionProgress = {
  completed: number;
  total: number;
  percent: number;
};

export type ItemNavigationTarget = {
  sectionId: string;
  itemId: string;
};

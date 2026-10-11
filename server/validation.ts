import { z } from "zod";
export const idSchema = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[A-Za-z0-9_-]+$/);
export const kinds = z.enum(["reports", "inspections"]);
export const catalogKinds = z.enum([
  "clients",
  "technicians",
  "equipment",
  "parts",
]);
export const catalogInput = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  identifier: z.string().optional().nullable(),
  clientId: idSchema.optional().nullable(),
  data: z.record(z.unknown()).default({}),
  baseVersion: z.number().int().min(0).default(0),
  mutationId: idSchema.optional(),
});
export const recordInput = z.object({
  number: z.string().trim().min(1, "Número obrigatório.").max(100),
  clientId: idSchema.nullable(),
  technicianId: idSchema.nullable(),
  equipmentId: idSchema.nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["draft", "finalized"]),
  payload: z.record(z.any()),
  baseVersion: z.number().int().min(0),
  mutationId: idSchema,
});
export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});
export const archiveCatalogInput = z.object({
  baseVersion: z.number().int().min(1),
  mutationId: idSchema.optional(),
});
export const mediaInput = z.object({
  dataUrl: z.string(),
  name: z.string().max(300).default("imagem"),
});
export const recordFilter = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  clientId: idSchema.optional(),
  technicianId: idSchema.optional(),
  status: z.enum(["draft", "finalized"]).optional(),
  q: z.string().max(200).optional(),
});
const text = z.string().max(20000);
const media = z.object({
  id: z.string().optional(),
  uri: z.string().max(250),
  name: z.string().max(300),
  width: z.number().optional(),
  height: z.number().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
});
const period = z.object({ start: z.string().max(5), end: z.string().max(5) });
const participantPeriods = z
  .array(
    z.object({
      id: z.string().min(1).max(140),
      kind: z.enum(["outbound", "work", "inbound"]),
      start: z.string().max(5),
      end: z.string().max(5),
      pauseMinutes: z.string().max(30),
    }),
  )
  .max(1000)
  .refine(
    (items) => new Set(items.map((x) => x.id)).size === items.length,
    "Períodos com identificadores repetidos.",
  );
export const reportSchema = z.object({
  type: z.enum(["interno", "externo"]),
  operator: text,
  requester: text,
  location: text,
  auxiliaries: z.array(z.string().max(140)),
  additionalTechnicians: z
    .array(
      z.object({
        technicianId: z
          .string()
          .min(1)
          .max(140)
          .regex(/^[A-Za-z0-9_-]+$/),
        role: z.enum(["technician", "auxiliary"]),
      }),
    )
    .optional(),
  equipment: z.record(z.string().max(1000)),
  reasons: z
    .array(
      z.object({
        id: z.string(),
        description: text,
        pending: text,
        services: z
          .array(
            z.object({
              id: z.string(),
              description: text,
              notes: text,
              photos: z.array(media).max(50),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
  parts: z
    .array(
      z.object({
        id: z.string(),
        catalogId: z.string().optional(),
        code: z.string().max(300),
        description: text,
        supplier: text,
        quantity: z.number().finite().positive(),
        kind: z.enum(["requested", "replaced"]),
        codeHistory: z.array(z.string()).max(100),
      }),
    )
    .max(1000),
  days: z
    .array(
      z.object({
        id: z.string(),
        date: z.string().date(),
        notes: text.optional(),
        participants: z
          .array(
            z.object({
              technicianId: z.string().min(1).max(140),
              present: z.boolean(),
              odometerStart: z.string().max(30),
              odometerEnd: z.string().max(30),
              sameHoursAs: z.string().min(1).max(140).nullable(),
              sameVehicleAs: z.string().min(1).max(140).nullable(),
              periods: participantPeriods,
            }),
          )
          .max(1000)
          .optional(),
        odometerStart: z.string(),
        odometerEnd: z.string(),
        hourmeter: z.string(),
        hourmeterLower: z.string().optional(),
        hourmeterUpper: z.string().optional(),
        outbound: period,
        work: period,
        inbound: period,
        pause: z.object({
          period: z.enum(["work", "outbound", "inbound"]),
          minutes: z.string(),
        }),
        periods: z
          .array(
            z.object({
              id: z.string().min(1).max(140),
              kind: z.enum(["outbound", "work", "inbound"]),
              start: z.string().max(5),
              end: z.string().max(5),
              pauseMinutes: z.string().max(30),
            }),
          )
          .max(1000)
          .refine(
            (periods) =>
              new Set(periods.map((p) => p.id)).size === periods.length,
            "Períodos com identificadores repetidos.",
          )
          .optional(),
      }),
    )
    .max(365),
  concluded: z.enum(["", "Sim", "Não"]),
  released: z.enum(["", "Sim", "Não"]),
  photosSent: z.enum(["", "Sim", "Não"]),
  observations: text,
  technicianSignature: media.optional(),
  clientSignature: media.optional(),
});
export const inspectionSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(300).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  finalizedAt: z.string().nullable().optional(),
  documentFields: z.record(text),
  approvedByTechnicianId: z.string().nullable().optional(),
  documentImages: z.record(z.array(media).max(50)),
  sections: z
    .array(
      z.object({
        id: z.string(),
        name: text,
        items: z
          .array(
            z.object({
              id: z.string(),
              code: z.string(),
              name: text,
              situation: z.enum(["", "A", "B", "C", "D"]).nullable().optional(),
              observation: text,
              images: z.array(media).max(50),
              updatedAt: z.string().datetime({ offset: true }).optional(),
            }),
          )
          .max(200),
      }),
    )
    .max(50),
  signature: media.optional(),
  technicianSignature: media.nullable().optional(),
  clientSignature: media.nullable().optional(),
});

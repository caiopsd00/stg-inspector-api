import { z } from "zod";
import { catalogKinds as catalogKindValues } from "../contracts/domain.js";
export const idSchema = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[A-Za-z0-9_-]+$/);
export const kinds = z.enum(["reports", "inspections"]);
export const catalogKinds = z.enum(catalogKindValues);
export const catalogInput = z.object({
  id: idSchema,
  name: z.string().trim().max(300).default(""),
  identifier: z.string().optional().nullable(),
  clientId: idSchema.optional().nullable(),
  data: z.record(z.string(), z.unknown()).default({}),
  baseVersion: z.number().int().min(0).default(0),
  mutationId: idSchema.optional(),
});
export const recordInput = z.object({
  number: z.string().trim().min(1, "Número obrigatório.").max(100),
  clientId: idSchema.nullable(),
  technicianId: idSchema.nullable(),
  equipmentId: idSchema.nullable(),
  vehicleId: idSchema.nullable().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  status: z.enum(["draft", "finalized"]),
  payload: z.record(z.string(), z.any()),
  baseVersion: z.number().int().min(0),
  mutationId: idSchema,
});
export const loginInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});
export const archiveCatalogInput = z.object({
  baseVersion: z.number().int().min(1),
  mutationId: idSchema.optional(),
});
export const mediaInput = z.object({
  dataUrl: z.string(),
  name: z.string().max(300).default("imagem"),
  signature: z
    .object({
      kind: kinds,
      recordId: idSchema,
      signerRole: z.enum(["technician", "client"]),
      signerName: z
        .string()
        .trim()
        .min(1, "Informe o nome de quem assinou.")
        .max(300),
    })
    .optional(),
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
  captureId: z.uuid().optional(),
  signerName: z.string().max(300).optional(),
});
const period = z.object({ start: z.string().max(5), end: z.string().max(5) });
const yesNo = z.enum(["", "Sim", "Não"]);
const schedulePeriods = z
  .array(
    z.object({
      id: z.string().min(1).max(140),
      kind: z.enum(["outbound", "work", "inbound"]),
      start: z.string().max(5),
      end: z.string().max(5),
      pauseMinutes: z.string().max(30),
      odometerStart: z.string().max(30).optional(),
      odometerEnd: z.string().max(30).optional(),
    }),
  )
  .max(1000)
  .refine(
    (items) => new Set(items.map((x) => x.id)).size === items.length,
    "Períodos com identificadores repetidos.",
  );
const scheduleDay = z.object({
  id: z.string().min(1).max(140),
  date: z.string().date(),
  notes: text.optional(),
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
  periods: schedulePeriods.optional(),
});
export const reportSchema = z.object({
  formRevision: z.literal(2).optional(),
  primaryTechnicianCharged: yesNo.optional(),
  primaryTechnicianRole: z.enum(["technician", "auxiliary"]).optional(),
  type: z.enum(["interno", "externo", "remoto"]),
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
        charged: yesNo.optional(),
      }),
    )
    .optional(),
  equipment: z.record(z.string(), z.string().max(1000)),
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
              photos: z.array(media).max(5000),
              completed: yesNo.optional(),
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
      scheduleDay.extend({
        participants: z
          .array(
            z.object({
              technicianId: z.string().min(1).max(140),
              present: z.boolean(),
              odometerStart: z.string().max(30),
              odometerEnd: z.string().max(30),
              sameHoursAs: z.string().min(1).max(140).nullable(),
              sameVehicleAs: z.string().min(1).max(140).nullable(),
              periods: schedulePeriods,
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .max(365),
  concluded: z.enum(["", "Sim", "Não"]),
  released: z.enum(["", "Sim", "Não"]),
  photosSent: yesNo.default(""),
  observations: text,
  technicianSignature: media.optional(),
  clientSignature: media.optional(),
});
export const inspectionSchema = z.object({
  formRevision: z.literal(2).optional(),
  days: z.array(scheduleDay).max(365).optional(),
  id: z.string().optional(),
  name: z.string().max(300).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  finalizedAt: z.string().nullable().optional(),
  documentFields: z.record(z.string(), text),
  approvedByTechnicianId: z.string().nullable().optional(),
  documentImages: z.record(z.string(), z.array(media).max(50)),
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

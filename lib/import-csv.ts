import Papa from "papaparse";
import { z } from "zod";

import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

export const csvColumnMappingSchema = z.object({
  businessName: z.string().optional(),
  contactName: z.string().optional(),
  phoneNumber: z.string(),
  city: z.string().optional(),
  state: z.string().optional(),
  niche: z.string().optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
});

export const importCsvSchema = z.object({
  leadListName: z.string().min(1),
  sourceFileName: z.string().min(1),
  csvText: z.string().min(1),
  mapping: csvColumnMappingSchema,
});

export type ImportCsvInput = z.infer<typeof importCsvSchema>;

export async function importLeadsFromCsv(input: ImportCsvInput) {
  const parsed = Papa.parse<Record<string, string>>(input.csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse error: ${parsed.errors[0]?.message ?? "Unknown parse failure"}`);
  }

  const headers = parsed.meta.fields ?? [];
  const rows = parsed.data;

  if (!headers.includes(input.mapping.phoneNumber)) {
    throw new Error("Selected phone number column is missing from CSV headers");
  }

  const leadList = await prisma.leadList.create({
    data: {
      name: input.leadListName,
      sourceFileName: input.sourceFileName,
    },
  });

  const importedPhoneNumbers = new Set<string>();
  let importedRows = 0;
  let skippedRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const sourcePhone = row[input.mapping.phoneNumber] ?? "";
    const normalizedPhone = normalizePhoneNumber(sourcePhone);

    if (!normalizedPhone) {
      skippedRows += 1;
      continue;
    }

    if (importedPhoneNumbers.has(normalizedPhone)) {
      duplicateRows += 1;
      continue;
    }

    importedPhoneNumbers.add(normalizedPhone);

    const mappedColumns = new Set(
      Object.values(input.mapping).filter((value): value is string => Boolean(value && value.length > 0)),
    );

    const customFields: Record<string, string> = {};

    for (const [key, value] of Object.entries(row)) {
      if (!mappedColumns.has(key)) {
        customFields[key] = value;
      }
    }

    try {
      await prisma.lead.create({
        data: {
          leadListId: leadList.id,
          businessName: input.mapping.businessName ? row[input.mapping.businessName] ?? null : null,
          contactName: input.mapping.contactName ? row[input.mapping.contactName] ?? null : null,
          phoneNumber: normalizedPhone,
          city: input.mapping.city ? row[input.mapping.city] ?? null : null,
          state: input.mapping.state ? row[input.mapping.state] ?? null : null,
          niche: input.mapping.niche ? row[input.mapping.niche] ?? null : null,
          website: input.mapping.website ? row[input.mapping.website] ?? null : null,
          notes: input.mapping.notes ? row[input.mapping.notes] ?? null : null,
          customFieldsJson: customFields,
        },
      });

      importedRows += 1;
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("duplicate")) {
        duplicateRows += 1;
        continue;
      }

      throw error;
    }
  }

  return {
    leadList,
    summary: {
      totalRows: rows.length,
      importedRows,
      skippedRows,
      duplicateRows,
    },
  };
}

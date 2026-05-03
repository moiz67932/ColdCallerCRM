import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, jsonError } from "@/lib/http";
import { importLeadsFromCsv, importCsvSchema } from "@/lib/import-csv";

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const payload = importCsvSchema.parse(await request.json());
    const result = await importLeadsFromCsv(payload);

    return NextResponse.json({
      leadListId: result.leadList.id,
      leadListName: result.leadList.name,
      summary: result.summary,
    });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}

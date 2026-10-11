import type { Request, Response } from "express";
import { z } from "zod";

import { authorizedMedia, uploadMedia } from "../application/media-service.js";
import { mediaInput } from "../validation.js";

export const mediaController = {
  async upload(req: Request, res: Response) {
    const { dataUrl, name } = mediaInput.parse(req.body);
    res
      .status(201)
      .json({ media: await uploadMedia(req.user!, dataUrl, name) });
  },
  async get(req: Request, res: Response) {
    const id = z.string().uuid().parse(req.params.id);
    const media = await authorizedMedia(req.user!, id);
    res.type(media.mime).sendFile(media.filePath);
  },
};

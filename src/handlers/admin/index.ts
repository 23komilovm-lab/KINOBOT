import { Composer } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import { isAdmin } from "../../config.js";
import type { MyContext } from "../../types.js";

import { statisticsHandler } from "./statistics.js";
import { channelsHandler } from "./channels.js";
import { moviesHandler, addMovie } from "./movies.js";
import { serialsHandler, addSerial, addEpisode } from "./serials.js";
import { broadcastHandler } from "./broadcast.js";
import { backupHandler } from "./backup.js";
import { adminsHandler } from "./admins.js";
import { joinStatsHandler } from "./joinStats.js";
import { funnelHandler } from "./funnel.js";
import { referralsHandler } from "./referrals.js";
import { aiAdminHandler } from "./aiAdmin.js";
import { aiSettingsHandler } from "./aiSettings.js";
import { premiumAdminHandler } from "./premium.js";
import { botSettingsHandler } from "./botSettings.js";

// Faqat adminlar uchun
export const adminHandler = new Composer<MyContext>();
const admin = adminHandler.filter((ctx) => isAdmin(ctx.from?.id));

// Conversation'larni ro'yxatdan o'tkazish
admin.use(createConversation(addMovie, "addMovie"));
admin.use(createConversation(addSerial, "addSerial"));
admin.use(createConversation(addEpisode, "addEpisode"));

// Bo'limlar
admin.use(statisticsHandler);
admin.use(channelsHandler);
admin.use(moviesHandler);
admin.use(serialsHandler);
admin.use(broadcastHandler);
admin.use(backupHandler);
admin.use(adminsHandler);
admin.use(joinStatsHandler);
admin.use(funnelHandler);
admin.use(referralsHandler);
admin.use(aiAdminHandler);
admin.use(aiSettingsHandler);
admin.use(premiumAdminHandler);
admin.use(botSettingsHandler);

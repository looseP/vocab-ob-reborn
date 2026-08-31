export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLiveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPrometheusMetrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAuthSession"];
        put?: never;
        post: operations["createAuthSession"];
        delete: operations["deleteAuthSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/operations/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getOperationMetrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/words": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWords"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/words/suggest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["suggestWords"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/words/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWord"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/words/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["batchCreateWords"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/words/{slug}/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWordNote"];
        put: operations["upsertWordNote"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plaza": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPlazaOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plaza/collections/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPlazaCollection"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plaza/roots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPlazaRootsOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plaza/roots/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPlazaRootCollection"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listNotes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/wordbooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWordbooks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/wordbooks/default": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getOrCreateDefaultWordbook"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReviewQueue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReviewStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/stats/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReviewDashboardStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/leeches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listReviewLeeches"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listReviewTimeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/heatmap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReviewHeatmap"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitReviewAnswer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/skip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["skipReview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/suspend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["suspendReview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["undoReview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/weak-signal/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["clearL1WeakSignal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/cards": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["enqueueReviewCard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/cards/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["enqueueReviewCardsBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/review/drill/queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReviewDrillQueue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/capture": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createCapture"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/imports/vocab-notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["importVocabNotes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2/{slug}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL2Draft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2/{slug}/external-prompt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL2ExternalPrompt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2/{slug}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["confirmL2Draft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2-drill/queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL2DrillQueue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2-drill/task/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitL2TaskAnswer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2-drill/self-assess": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitL2SelfAssessment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l2-drill/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["undoL2Drill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3Source"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/contexts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3Context"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/occurrences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3Occurrence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/context-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3ContextLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/occurrences/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteL3Occurrence"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/context-links/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteL3ContextLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/sources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteL3Source"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/contexts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3Context"];
        put?: never;
        post?: never;
        delete: operations["deleteL3Context"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/words/{slug}/space": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3WordSpace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/sources/{id}/space": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3SourceSpace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3Graph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/words/{slug}/contexts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listL3WordContexts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/sources/{id}/contexts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listL3SourceContexts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/imports/raw-text": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3RawTextImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/imports/structured": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createL3StructuredImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listL3Proposals"];
        put?: never;
        post: operations["createL3Proposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/recommendations/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["generateL3Recommendations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/recommendations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listL3Recommendations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/recommendations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3Recommendation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/recommendations/{id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["acceptL3Recommendation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/recommendations/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rejectL3Recommendation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/proposals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getL3Proposal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/proposals/{id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["validateL3Proposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/proposals/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["confirmL3Proposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/l3/proposals/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rejectL3Proposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface components {
    schemas: {
        JsonValue: JsonValue;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getLiveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        status: "ok";
                    };
                };
            };
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        service: string;
                        phase: string;
                    };
                };
            };
        };
    };
    getReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not ready */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPrometheusMetrics: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Metrics unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    getAuthSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        authenticated: true;
                        actorId: string;
                        role: string;
                        authMethod: string;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createAuthSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Must match the configured application origin. */
                Origin: string;
                /** @description Must equal VocabObservatory. */
                "X-Requested-With": "VocabObservatory";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    ownerToken: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    /** @description Prevents authentication state from being cached. */
                    "Cache-Control"?: string;
                    /** @description Sets or clears the session and CSRF cookies. */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        authenticated: true;
                        actorId: string;
                        role: string;
                        expiresAt: string;
                        csrfToken: string;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Unsupported media type */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Rate limited */
            429: {
                headers: {
                    /** @description Prevents authentication state from being cached. */
                    "Cache-Control"?: string;
                    /** @description Seconds before another authentication attempt. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteAuthSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getOperationMetrics: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        process: {
                            uptimeSeconds: number;
                            draining: boolean;
                        };
                        database: {
                            healthy: boolean;
                            totalConnections: number;
                            idleConnections: number;
                            waitingRequests: number;
                        };
                        outbox: {
                            pending: number;
                            processing: number;
                            deadLetter: number;
                            oldestPendingAgeSeconds: number | null;
                        };
                        llmReservations: {
                            pending: number;
                            expiredPending: number;
                            oldestPendingAgeSeconds: number;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listWords: {
        parameters: {
            query?: {
                cefr?: string;
                limit?: number;
                offset?: number;
                q?: string;
                review?: "all" | "tracked" | "due" | "untracked";
                wordbookId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            slug: string;
                            title: string;
                            lemma: string;
                            pos: string | null;
                            cefr: string | null;
                            ipa: string | null;
                            short_definition: string | null;
                            metadata: components["schemas"]["JsonValue"];
                        }[];
                        total: number;
                        limit: number;
                        offset: number;
                        hasMore: boolean;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    suggestWords: {
        parameters: {
            query: {
                limit?: number;
                q: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            slug: string;
                            title: string;
                            lemma: string;
                            pos: string | null;
                            cefr: string | null;
                            ipa: string | null;
                            short_definition: string | null;
                            metadata: components["schemas"]["JsonValue"];
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getWord: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        slug: string;
                        title: string;
                        lemma: string;
                        pos: string | null;
                        cefr: string | null;
                        ipa: string | null;
                        aliases: string[];
                        short_definition: string | null;
                        definition_md: string;
                        body_md: string;
                        examples: components["schemas"]["JsonValue"];
                        prototype_text: string | null;
                        metadata: components["schemas"]["JsonValue"];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    batchCreateWords: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    words: {
                        slug?: string;
                        title?: string;
                        lemma?: string;
                        pos?: string;
                        cefr?: string;
                        ipa?: string;
                        short_definition?: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        inserted: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getWordNote: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        content_md: string;
                        updated_at: string | null;
                        version: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    upsertWordNote: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content_md?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPlazaOverview: {
        parameters: {
            query?: {
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        available: boolean;
                        counts: {
                            showing: number;
                            total: number;
                        };
                        groups: {
                            /** @constant */
                            kind: "semantic_field";
                            label: string;
                            count: number;
                            collections: {
                                slug: string;
                                title: string;
                                /** @constant */
                                kind: "semantic_field";
                                count: number;
                                updatedAt: string;
                            }[];
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPlazaCollection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        slug: string;
                        title: string;
                        /** @constant */
                        kind: "semantic_field";
                        count: number;
                        updatedAt: string;
                        words: {
                            id: string;
                            slug: string;
                            lemma: string;
                            cefr: string | null;
                            short_definition: string | null;
                            semantic_chain: string | null;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPlazaRootsOverview: {
        parameters: {
            query?: {
                letter?: string;
                minCount?: number;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        available: boolean;
                        counts: {
                            showing: number;
                            total: number;
                        };
                        collections: {
                            slug: string;
                            title: string;
                            /** @constant */
                            kind: "root_affix";
                            count: number;
                            updatedAt: string;
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPlazaRootCollection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        slug: string;
                        title: string;
                        /** @constant */
                        kind: "root_affix";
                        count: number;
                        updatedAt: string;
                        /** @enum {string} */
                        type: "simple" | "compound" | "mixed";
                        words: {
                            id: string;
                            slug: string;
                            lemma: string;
                            cefr: string | null;
                            short_definition: string | null;
                            semantic_chain: string | null;
                            root: string | null;
                            prefix: string | null;
                            suffix: string | null;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listNotes: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            wordSlug: string;
                            wordLemma: string;
                            wordTitle: string;
                            contentMd: string;
                            version: number;
                            updatedAt: string | null;
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listWordbooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            name: string;
                            description: string | null;
                            isDefault: boolean;
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getOrCreateDefaultWordbook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        description: string | null;
                        isDefault: boolean;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReviewQueue: {
        parameters: {
            query?: {
                limit?: number;
                mode?: "review" | "cram" | "preview";
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            progressId: string;
                            word: {
                                id: string;
                                slug: string;
                                title: string;
                                lemma: string;
                                short_definition: string | null;
                                ipa: string | null;
                                pos: string | null;
                                cefr: string | null;
                            };
                            /** @enum {string} */
                            state: "new" | "learning" | "review" | "relearning";
                            dueAt: string | null;
                            lastRating: ("again" | "hard" | "good" | "easy") | null;
                            reviewCount: number;
                        }[];
                        session: {
                            id: string;
                            mode: string;
                            cardsSeen: number;
                        };
                        stats: {
                            total: number;
                            remaining: number;
                        };
                        hasMore: boolean;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReviewStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        todayCount: number;
                        totalCount: number;
                        ratingDist: {
                            again: number;
                            hard: number;
                            good: number;
                            easy: number;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReviewDashboardStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        totalWords: number;
                        trackedWords: number;
                        dueToday: number;
                        reviewedToday: number;
                        reviewed7d: number;
                        reviewed30d: number;
                        streakDays: number;
                        notesCount: number;
                        ratingDist: {
                            again: number;
                            hard: number;
                            good: number;
                            easy: number;
                        };
                        forecast: {
                            dueNow: number;
                            due7d: number;
                            due14d: number;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listReviewLeeches: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            progressId: string;
                            word: {
                                id: string;
                                slug: string;
                                title: string;
                                lemma: string;
                                short_definition: string | null;
                            };
                            lapseCount: number;
                            /** @enum {string} */
                            state: "new" | "learning" | "review" | "relearning";
                            dueAt: string | null;
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listReviewTimeline: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            rating: string;
                            created_at: string;
                            word_slug: string;
                            word_lemma: string;
                        }[];
                        total: number;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReviewHeatmap: {
        parameters: {
            query?: {
                days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            date: string;
                            count: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitReviewAnswer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    progressId: string;
                    /** @enum {string} */
                    rating: "again" | "hard" | "good" | "easy";
                    /** Format: uuid */
                    sessionId: string;
                    idempotencyKey?: string;
                    /** @enum {string} */
                    mode?: "review" | "cram" | "preview" | "zen";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                        /** Format: uuid */
                        reviewLogId: string;
                        /** Format: date-time */
                        nextDueAt?: string;
                        /** @enum {string} */
                        state?: "new" | "learning" | "review" | "relearning";
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    skipReview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    progressId: string;
                    /** Format: uuid */
                    sessionId: string;
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    suspendReview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    progressId: string;
                    /** Format: uuid */
                    sessionId?: string;
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    undoReview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reviewLogId: string;
                    /** Format: uuid */
                    sessionId: string;
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    clearL1WeakSignal: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    wordId: string;
                    /** Format: uuid */
                    wordbookId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    enqueueReviewCard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    wordId: string;
                    /** Format: uuid */
                    wordbookId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** Format: uuid */
                        progressId: string;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    enqueueReviewCardsBatch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordIds: string[];
                    /** Format: uuid */
                    wordbookId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        added: number;
                        skipped: number;
                        progressIds: string[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReviewDrillQueue: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            progressId: string;
                            wordId: string;
                            lemma: string;
                            title: string;
                            slug: string;
                            shortDefinition: string | null;
                            /** @enum {string} */
                            state: "new" | "learning" | "review" | "relearning";
                            clozeText: string;
                            clozeLength: number;
                            clozeSource: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createCapture: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    headword: string;
                    sentence?: string;
                    /** Format: uri */
                    sourceUrl?: string;
                    obsidianRef?: string;
                    /** Format: uuid */
                    wordbookId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        existed: boolean;
                        word: {
                            /** Format: uuid */
                            id: string;
                            slug: string;
                            title: string;
                            lemma: string;
                            shortDefinition: string | null;
                        };
                        noteContentMd: string | null;
                        /** @constant */
                        l3Status: "deferred";
                        sourceId: string | null;
                        contextId: string | null;
                        occurrenceId: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    importVocabNotes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    files: {
                        path: string;
                        content: string;
                        updatedAt?: string | null;
                    }[];
                    dryRun?: boolean;
                    /**
                     * @default standard
                     * @enum {string}
                     */
                    strictness?: "lenient" | "standard" | "strict";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        dryRun: boolean;
                        results: {
                            path: string;
                            /** @enum {string} */
                            status: "imported" | "unchanged" | "needs_supplement" | "rejected" | "failed";
                            total: number;
                            imported: number;
                            unchanged: number;
                            needsSupplement: number;
                            rejected: number;
                            failedWords: number;
                            minScore: number | null;
                            issues: string[];
                            error?: string;
                            words: {
                                slug: string;
                                pos: string | null;
                                cefr: string | null;
                                /** @enum {string} */
                                tier: "ok" | "needs_supplement" | "rejected";
                                score: number;
                                issues: string[];
                                /** @enum {string} */
                                outcome?: "imported" | "unchanged";
                            }[];
                        }[];
                        stats: {
                            files: number;
                            imported: number;
                            unchanged: number;
                            needsSupplement: number;
                            rejected: number;
                            failed: number;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL2Draft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    field: "collocation" | "example" | "corpus" | "synonym" | "antonym";
                    styleProfileId?: string;
                    userInstruction?: string;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        draft: components["schemas"]["JsonValue"];
                        /** @enum {string} */
                        sourceMode?: "internal_llm" | "dictionary" | "dictionary_llm_refined";
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Upstream or budget unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL2ExternalPrompt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    field: "collocation" | "example" | "corpus" | "synonym" | "antonym";
                    styleProfileId?: string;
                    userInstruction?: string;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        field: "collocation" | "corpus" | "example" | "synonym" | "antonym";
                        /** @enum {string} */
                        storageField: "collocation" | "corpus" | "synonym" | "antonym";
                        styleProfileId: string;
                        promptVersion: string;
                        promptHash: string;
                        prompt: string;
                        expectedJsonSchema: components["schemas"]["JsonValue"];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Upstream or budget unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    confirmL2Draft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    field: "collocation" | "example" | "corpus" | "synonym" | "antonym";
                    styleProfileId?: string;
                    userInstruction?: string;
                    content?: unknown;
                    items?: unknown[];
                    document?: unknown;
                    source?: string;
                    sourceRef?: string | null;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Upstream or budget unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL2DrillQueue: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            progressId: string;
                            stepId: string;
                            word: {
                                id: string;
                                slug: string;
                                title: string;
                                lemma: string;
                                short_definition: string | null;
                                ipa: string | null;
                                pos: string | null;
                                cefr: string | null;
                            };
                            l2DueAt: string | null;
                            l2ReviewCount: number;
                            singleStep: boolean;
                            task: {
                                taskId: string;
                                /** @enum {string} */
                                taskType: "cloze_mcq" | "synonym_discrimination" | "production";
                                prompt: string;
                                stepIndex: number;
                                options?: string[];
                                hintTranslation?: string | null;
                                referenceExample?: string | null;
                                sourceTitle?: string | null;
                                contextId?: string | null;
                            } & {
                                [key: string]: unknown;
                            };
                        }[];
                        session: {
                            id: string;
                            mode: string;
                        };
                        stats: {
                            total: number;
                            remaining: number;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitL2TaskAnswer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    sessionId: string;
                    /** Format: uuid */
                    stepId: string;
                    choiceIndex: number;
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                        /** @constant */
                        skipped?: true;
                        /** @enum {string} */
                        outcome?: "correct" | "incorrect";
                        /** @enum {string} */
                        mappedRating?: "again" | "hard" | "good" | "easy";
                        /** Format: uuid */
                        l2ReviewLogId?: string;
                        l2NextDueAt?: string | null;
                        nextStep: {
                            /** @constant */
                            type: "done";
                        } | {
                            /** @constant */
                            type: "production";
                            step: {
                                stepId: string;
                                task: {
                                    taskId: string;
                                    /** @enum {string} */
                                    taskType: "cloze_mcq" | "synonym_discrimination" | "production";
                                    prompt: string;
                                    stepIndex: number;
                                    options?: string[];
                                    hintTranslation?: string | null;
                                    referenceExample?: string | null;
                                    sourceTitle?: string | null;
                                    contextId?: string | null;
                                } & {
                                    [key: string]: unknown;
                                };
                            };
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitL2SelfAssessment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    sessionId: string;
                    /** Format: uuid */
                    stepId: string;
                    /** @enum {string} */
                    verdict: "passed" | "weak";
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @enum {string} */
                        productionStatus: "passed" | "weak";
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    undoL2Drill: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    sessionId: string;
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        /** @constant */
                        idempotent?: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3Source: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordbookId?: string | null;
                    /** @enum {string} */
                    sourceType: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                    title: string;
                    author?: string | null;
                    url?: string | null;
                    language?: string | null;
                    /** @default {} */
                    metadata?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        source: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                            title: string;
                            author: string | null;
                            url: string | null;
                            language: string | null;
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3Context: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    sourceId: string;
                    /** @enum {string} */
                    contextType: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                    text: string;
                    normalizedText?: string | null;
                    language?: string | null;
                    /** @default {} */
                    position?: {
                        [key: string]: unknown;
                    };
                    /** @default {} */
                    metadata?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        context: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3Occurrence: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    contextId: string;
                    /** Format: uuid */
                    wordId?: string;
                    slug?: string;
                    surface: string;
                    lemma?: string | null;
                    startOffset?: number | null;
                    endOffset?: number | null;
                    confidence?: number | null;
                    /** @default {} */
                    evidence?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        occurrence: {
                            id: string;
                            context_id: string;
                            word_id: string;
                            user_id: string;
                            surface: string;
                            lemma: string | null;
                            start_offset: number | null;
                            end_offset: number | null;
                            confidence: (number | string) | null;
                            evidence: components["schemas"]["JsonValue"];
                            created_at: string;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3ContextLink: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    contextId?: string | null;
                    wordId?: string | null;
                    /** @enum {string} */
                    linkType: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                    /** @enum {string} */
                    targetType: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                    targetId?: string | null;
                    /** @default {} */
                    targetRef?: {
                        [key: string]: unknown;
                    };
                    confidence?: number | null;
                    /** @default {} */
                    provenance?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        link: {
                            id: string;
                            user_id: string;
                            context_id: string | null;
                            word_id: string | null;
                            /** @enum {string} */
                            link_type: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                            /** @enum {string} */
                            target_type: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                            target_id: string | null;
                            target_ref: components["schemas"]["JsonValue"];
                            confidence: (number | string) | null;
                            provenance: components["schemas"]["JsonValue"];
                            created_at: string;
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteL3Occurrence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: {
                            /** @enum {string} */
                            entityType: "source" | "context" | "occurrence" | "context_link";
                            id: string;
                        };
                        /** @constant */
                        activeReadInvalidation: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteL3ContextLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: {
                            /** @enum {string} */
                            entityType: "source" | "context" | "occurrence" | "context_link";
                            id: string;
                        };
                        /** @constant */
                        activeReadInvalidation: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteL3Source: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: {
                            /** @enum {string} */
                            entityType: "source" | "context" | "occurrence" | "context_link";
                            id: string;
                        };
                        /** @constant */
                        activeReadInvalidation: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3Context: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        context: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        };
                        source: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                            title: string;
                            author: string | null;
                            url: string | null;
                            language: string | null;
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        };
                        occurrences: {
                            id: string;
                            context_id: string;
                            word_id: string;
                            user_id: string;
                            surface: string;
                            lemma: string | null;
                            start_offset: number | null;
                            end_offset: number | null;
                            confidence: (number | string) | null;
                            evidence: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                        links: {
                            id: string;
                            user_id: string;
                            context_id: string | null;
                            word_id: string | null;
                            /** @enum {string} */
                            link_type: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                            /** @enum {string} */
                            target_type: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                            target_id: string | null;
                            target_ref: components["schemas"]["JsonValue"];
                            confidence: (number | string) | null;
                            provenance: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteL3Context: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: {
                            /** @enum {string} */
                            entityType: "source" | "context" | "occurrence" | "context_link";
                            id: string;
                        };
                        /** @constant */
                        activeReadInvalidation: true;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3WordSpace: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                wordbookId?: string;
            };
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        word: {
                            id: string;
                            slug: string;
                            title: string;
                            lemma: string;
                            pos: string | null;
                            cefr: string | null;
                            ipa: string | null;
                            aliases: string[];
                            short_definition: string | null;
                            definition_md: string;
                            body_md: string;
                            prototype_text: string | null;
                            examples: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            source_path: string;
                            source_updated_at: string | null;
                            content_hash: string;
                            is_published: boolean;
                            is_deleted: boolean;
                            created_at: string;
                            updated_at: string;
                        };
                        contexts: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        }[];
                        sources: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                            title: string;
                            author: string | null;
                            url: string | null;
                            language: string | null;
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        }[];
                        occurrences: {
                            id: string;
                            context_id: string;
                            word_id: string;
                            user_id: string;
                            surface: string;
                            lemma: string | null;
                            start_offset: number | null;
                            end_offset: number | null;
                            confidence: (number | string) | null;
                            evidence: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                        links: {
                            id: string;
                            user_id: string;
                            context_id: string | null;
                            word_id: string | null;
                            /** @enum {string} */
                            link_type: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                            /** @enum {string} */
                            target_type: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                            target_id: string | null;
                            target_ref: components["schemas"]["JsonValue"];
                            confidence: (number | string) | null;
                            provenance: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                        stats: {
                            sourceCount: number;
                            contextCount: number;
                            occurrenceCount: number;
                            linkCount: number;
                        };
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3SourceSpace: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        source: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                            title: string;
                            author: string | null;
                            url: string | null;
                            language: string | null;
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        };
                        contexts: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        }[];
                        occurrences: {
                            id: string;
                            context_id: string;
                            word_id: string;
                            user_id: string;
                            surface: string;
                            lemma: string | null;
                            start_offset: number | null;
                            end_offset: number | null;
                            confidence: (number | string) | null;
                            evidence: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                        links: {
                            id: string;
                            user_id: string;
                            context_id: string | null;
                            word_id: string | null;
                            /** @enum {string} */
                            link_type: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                            /** @enum {string} */
                            target_type: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                            target_id: string | null;
                            target_ref: components["schemas"]["JsonValue"];
                            confidence: (number | string) | null;
                            provenance: components["schemas"]["JsonValue"];
                            created_at: string;
                        }[];
                        stats: {
                            sourceCount: number;
                            contextCount: number;
                            occurrenceCount: number;
                            linkCount: number;
                        };
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3Graph: {
        parameters: {
            query?: {
                cursor?: string;
                depth?: number;
                limit?: number;
                slug?: string;
                sourceId?: string;
                wordbookId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        nodes: {
                            id: string;
                            /** @enum {string} */
                            type: "word" | "context" | "source" | "l2_item" | "topic" | "external";
                            label: string;
                            ref: components["schemas"]["JsonValue"];
                            metadata?: components["schemas"]["JsonValue"];
                        }[];
                        edges: {
                            id: string;
                            /** @enum {string} */
                            type: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link" | "occurs_in" | "belongs_to";
                            sourceNodeId: string;
                            targetNodeId: string;
                            confidence?: (number | string) | null;
                            provenance?: components["schemas"]["JsonValue"];
                            evidence?: components["schemas"]["JsonValue"];
                        }[];
                        stats: {
                            sourceCount: number;
                            contextCount: number;
                            occurrenceCount: number;
                            linkCount: number;
                            nodeCount: number;
                            edgeCount: number;
                        };
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                        metadata?: components["schemas"]["JsonValue"];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listL3WordContexts: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        }[];
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listL3SourceContexts: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            source_id: string;
                            user_id: string;
                            /** @enum {string} */
                            context_type: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                            text: string;
                            normalized_text: string | null;
                            language: string | null;
                            position: components["schemas"]["JsonValue"];
                            metadata: components["schemas"]["JsonValue"];
                            created_at: string;
                            updated_at: string;
                        }[];
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3RawTextImport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordbookId?: string | null;
                    source: {
                        /** @enum {string} */
                        sourceType: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                        title: string;
                        author?: string | null;
                        url?: string | null;
                        language?: string | null;
                        /** @default {} */
                        metadata?: {
                            [key: string]: unknown;
                        };
                    };
                    text: string;
                    /** @default [] */
                    targetWords?: {
                        /** Format: uuid */
                        wordId?: string;
                        slug?: string;
                    }[];
                    options?: {
                        /**
                         * @default sentence
                         * @enum {string}
                         */
                        contextType?: "sentence" | "paragraph";
                        maxContexts?: number;
                        minContextLength?: number;
                        maxOccurrencesPerWordPerContext?: number;
                    };
                    /** @default {} */
                    provenance?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        importJob: {
                            id: string;
                            user_id: string;
                            source_id: string | null;
                            /** @enum {string} */
                            status: "pending" | "processing" | "completed" | "failed";
                            input_hash: string;
                            input_summary: string | null;
                            stats: components["schemas"]["JsonValue"];
                            error: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                        parseStats: {
                            contextCount: number;
                            occurrenceCount: number;
                            linkCount: number;
                            skippedContextCount: number;
                            warnings: string[];
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3StructuredImport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordbookId?: string | null;
                    source: {
                        /** @enum {string} */
                        sourceType: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
                        title: string;
                        author?: string | null;
                        url?: string | null;
                        language?: string | null;
                        /** @default {} */
                        metadata?: {
                            [key: string]: unknown;
                        };
                    };
                    contexts: {
                        clientRef?: string | null;
                        /** @enum {string} */
                        contextType: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
                        text: string;
                        normalizedText?: string | null;
                        language?: string | null;
                        /** @default {} */
                        position?: {
                            [key: string]: unknown;
                        };
                        /** @default {} */
                        metadata?: {
                            [key: string]: unknown;
                        };
                        /** @default [] */
                        occurrences?: {
                            /** Format: uuid */
                            wordId?: string;
                            slug?: string;
                            surface: string;
                            lemma?: string | null;
                            startOffset?: number | null;
                            endOffset?: number | null;
                            confidence?: number | null;
                            /** @default {} */
                            evidence?: {
                                [key: string]: unknown;
                            };
                        }[];
                        /** @default [] */
                        links?: {
                            wordId?: string | null;
                            /** @enum {string} */
                            linkType: "supports" | "illustrates" | "contrasts" | "collocates_with" | "synonym_of" | "antonym_of" | "derived_from" | "topic_related" | "manual_link";
                            /** @enum {string} */
                            targetType: "word" | "l2_item" | "context" | "source" | "topic" | "external";
                            targetId?: string | null;
                            /** @default {} */
                            targetRef?: {
                                [key: string]: unknown;
                            };
                            confidence?: number | null;
                            /** @default {} */
                            provenance?: {
                                [key: string]: unknown;
                            };
                        }[];
                    }[];
                    /** @default {} */
                    provenance?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        importJob: {
                            id: string;
                            user_id: string;
                            source_id: string | null;
                            /** @enum {string} */
                            status: "pending" | "processing" | "completed" | "failed";
                            input_hash: string;
                            input_summary: string | null;
                            stats: components["schemas"]["JsonValue"];
                            error: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                        parseStats: {
                            contextCount: number;
                            occurrenceCount: number;
                            linkCount: number;
                            skippedContextCount: number;
                            warnings: string[];
                        };
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listL3Proposals: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "pending" | "confirmed" | "rejected" | "canceled";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createL3Proposal: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordbookId?: string | null;
                    /** @enum {string} */
                    sourceType: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                    title?: string | null;
                    summary?: string | null;
                    inputHash?: string | null;
                    proposedBy?: string | null;
                    /** @default {} */
                    provenance?: {
                        [key: string]: unknown;
                    };
                    items: {
                        /** @enum {string} */
                        itemType: "source" | "context" | "occurrence" | "context_link";
                        clientRef?: string | null;
                        payload: {
                            [key: string]: unknown;
                        };
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    generateL3Recommendations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    wordbookId?: string | null;
                    /** @enum {string} */
                    mode: "review_pack" | "learn_next" | "gap_scan" | "link_suggestions";
                    seedSlug?: string | null;
                    limit?: number | null;
                    horizonDays?: number | null;
                    dryRun?: boolean | null;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        run: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            mode: "review_pack" | "learn_next" | "gap_scan" | "link_suggestions";
                            /** @enum {string} */
                            status: "completed" | "failed";
                            input_hash: string | null;
                            stats: components["schemas"]["JsonValue"];
                            created_at: string;
                            completed_at: string | null;
                        };
                        items: {
                            id: string;
                            run_id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            recommendation_type: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                            /** @enum {string} */
                            status: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
                            title: string;
                            summary: string;
                            priority_score: number | string;
                            confidence: number | string;
                            reason_codes: components["schemas"]["JsonValue"];
                            evidence: components["schemas"]["JsonValue"];
                            payload: components["schemas"]["JsonValue"];
                            accepted_proposal_id: string | null;
                            created_at: string;
                            updated_at: string;
                            expires_at: string | null;
                            accepted_at: string | null;
                            rejected_at: string | null;
                            dismissed_at: string | null;
                        }[];
                        stats: components["schemas"]["JsonValue"];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listL3Recommendations: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                recommendationType?: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                status?: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            run_id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            recommendation_type: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                            /** @enum {string} */
                            status: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
                            title: string;
                            summary: string;
                            priority_score: number | string;
                            confidence: number | string;
                            reason_codes: components["schemas"]["JsonValue"];
                            evidence: components["schemas"]["JsonValue"];
                            payload: components["schemas"]["JsonValue"];
                            accepted_proposal_id: string | null;
                            created_at: string;
                            updated_at: string;
                            expires_at: string | null;
                            accepted_at: string | null;
                            rejected_at: string | null;
                            dismissed_at: string | null;
                        }[];
                        limit: number;
                        cursor: string | null;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3Recommendation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        run_id: string;
                        user_id: string;
                        wordbook_id: string | null;
                        /** @enum {string} */
                        recommendation_type: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                        /** @enum {string} */
                        status: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
                        title: string;
                        summary: string;
                        priority_score: number | string;
                        confidence: number | string;
                        reason_codes: components["schemas"]["JsonValue"];
                        evidence: components["schemas"]["JsonValue"];
                        payload: components["schemas"]["JsonValue"];
                        accepted_proposal_id: string | null;
                        created_at: string;
                        updated_at: string;
                        expires_at: string | null;
                        accepted_at: string | null;
                        rejected_at: string | null;
                        dismissed_at: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    acceptL3Recommendation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            id: string;
                            run_id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            recommendation_type: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                            /** @enum {string} */
                            status: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
                            title: string;
                            summary: string;
                            priority_score: number | string;
                            confidence: number | string;
                            reason_codes: components["schemas"]["JsonValue"];
                            evidence: components["schemas"]["JsonValue"];
                            payload: components["schemas"]["JsonValue"];
                            accepted_proposal_id: string | null;
                            created_at: string;
                            updated_at: string;
                            expires_at: string | null;
                            accepted_at: string | null;
                            rejected_at: string | null;
                            dismissed_at: string | null;
                        };
                        proposal?: {
                            proposal: {
                                id: string;
                                user_id: string;
                                wordbook_id: string | null;
                                /** @enum {string} */
                                source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                                /** @enum {string} */
                                status: "pending" | "confirmed" | "rejected" | "canceled";
                                title: string | null;
                                summary: string | null;
                                input_hash: string | null;
                                proposed_by: string | null;
                                provenance: components["schemas"]["JsonValue"];
                                review_note: string | null;
                                confirmed_at: string | null;
                                rejected_at: string | null;
                                created_at: string;
                                updated_at: string;
                            };
                            items: {
                                id: string;
                                proposal_id: string;
                                user_id: string;
                                /** @enum {string} */
                                item_type: "source" | "context" | "occurrence" | "context_link";
                                ordinal: number;
                                payload: components["schemas"]["JsonValue"];
                                /** @enum {string} */
                                status: "pending" | "confirmed" | "rejected";
                                validation_errors: components["schemas"]["JsonValue"];
                                active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                                active_entity_id: string | null;
                                created_at: string;
                                updated_at: string;
                            }[];
                        };
                        actionPayload?: components["schemas"]["JsonValue"];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    rejectL3Recommendation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reviewNote?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        run_id: string;
                        user_id: string;
                        wordbook_id: string | null;
                        /** @enum {string} */
                        recommendation_type: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
                        /** @enum {string} */
                        status: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
                        title: string;
                        summary: string;
                        priority_score: number | string;
                        confidence: number | string;
                        reason_codes: components["schemas"]["JsonValue"];
                        evidence: components["schemas"]["JsonValue"];
                        payload: components["schemas"]["JsonValue"];
                        accepted_proposal_id: string | null;
                        created_at: string;
                        updated_at: string;
                        expires_at: string | null;
                        accepted_at: string | null;
                        rejected_at: string | null;
                        dismissed_at: string | null;
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getL3Proposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    validateL3Proposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                        valid: boolean;
                        errors: {
                            itemId: string;
                            ordinal: number;
                            /** @enum {string} */
                            itemType: "source" | "context" | "occurrence" | "context_link";
                            field: string;
                            message: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    confirmL3Proposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                        activeEntities: {
                            itemId: string;
                            /** @enum {string} */
                            itemType: "source" | "context" | "occurrence" | "context_link";
                            /** @enum {string} */
                            activeEntityType: "source" | "context" | "occurrence" | "context_link";
                            activeEntityId: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    rejectL3Proposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reviewNote?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        proposal: {
                            id: string;
                            user_id: string;
                            wordbook_id: string | null;
                            /** @enum {string} */
                            source_type: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected" | "canceled";
                            title: string | null;
                            summary: string | null;
                            input_hash: string | null;
                            proposed_by: string | null;
                            provenance: components["schemas"]["JsonValue"];
                            review_note: string | null;
                            confirmed_at: string | null;
                            rejected_at: string | null;
                            created_at: string;
                            updated_at: string;
                        };
                        items: {
                            id: string;
                            proposal_id: string;
                            user_id: string;
                            /** @enum {string} */
                            item_type: "source" | "context" | "occurrence" | "context_link";
                            ordinal: number;
                            payload: components["schemas"]["JsonValue"];
                            /** @enum {string} */
                            status: "pending" | "confirmed" | "rejected";
                            validation_errors: components["schemas"]["JsonValue"];
                            active_entity_type: ("source" | "context" | "occurrence" | "context_link") | null;
                            active_entity_id: string | null;
                            created_at: string;
                            updated_at: string;
                        }[];
                    };
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Authentication required */
            401: {
                headers: {
                    /** @description Bearer authentication challenge. */
                    "WWW-Authenticate"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payload too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Business rule rejected */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code: string;
                        message: string;
                        details?: unknown;
                        requestId: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
}

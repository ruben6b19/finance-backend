import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { errorHandler, notFoundHandler } from "./error.middleware.js";

const createTestApp = () => {
    const app = express();

    app.use("/api", express.json());

    app.get("/api/forbidden", () => {
        throw new ApiError(403, "nope");
    });

    app.get("/api/boom", () => {
        throw new Error("boom");
    });

    app.get("/api/validation", () => {
        throw new mongoose.Error.ValidationError();
    });

    app.get("/api/cast", () => {
        throw new mongoose.Error.CastError("ObjectId", "abc", "unit");
    });

    app.get("/api/duplicate", () => {
        const error = new Error("E11000 duplicate key error");
        error.code = 11000;
        throw error;
    });

    app.post("/api/echo", (req, res) => {
        res.status(200).json({ success: true, body: req.body });
    });

    app.get("/api/async-boom", async () => {
        throw new Error("async boom");
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

describe("errorHandler middleware", () => {
    let app;

    beforeEach(() => {
        app = createTestApp();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns the ApiError status and message", async () => {
        const response = await request(app).get("/api/forbidden");

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
            success: false,
            statusCode: 403,
            message: "nope"
        });
    });

    it("hides internal error details behind the generic Spanish message", async () => {
        const response = await request(app).get("/api/boom");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            success: false,
            statusCode: 500,
            message: "Ha ocurrido un error inesperado en el servidor."
        });

        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain("boom");
        expect(serialized).not.toContain("at ");
        expect(serialized).not.toContain("error.middleware.test.js");
        expect(console.error).toHaveBeenCalled();
    });

    it("maps a Mongoose ValidationError to 400", async () => {
        const response = await request(app).get("/api/validation");

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.statusCode).toBe(400);
        expect(typeof response.body.message).toBe("string");
        expect(response.body.message.length).toBeGreaterThan(0);
    });

    it("maps a Mongoose CastError to 400", async () => {
        const response = await request(app).get("/api/cast");

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.statusCode).toBe(400);
        expect(typeof response.body.message).toBe("string");
        expect(response.body.message.length).toBeGreaterThan(0);
    });

    it("maps a duplicate key error to 409", async () => {
        const response = await request(app).get("/api/duplicate");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            success: false,
            statusCode: 409,
            message: "E11000 duplicate key error"
        });
    });

    it("returns 400 with the generic Spanish message for malformed JSON bodies", async () => {
        const response = await request(app)
            .post("/api/echo")
            .set("Content-Type", "application/json")
            .send("{invalid json");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            statusCode: 400,
            message: "La solicitud no es válida."
        });

        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain("position");
        expect(serialized).not.toContain("Expected");
        expect(serialized).not.toContain("JSON");
    });

    it("returns the generic English message for malformed JSON bodies from English clients", async () => {
        const response = await request(app)
            .post("/api/echo")
            .set("Content-Type", "application/json")
            .set("Accept-Language", "en-US")
            .send("{invalid json");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            statusCode: 400,
            message: "The request is invalid."
        });

        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain("position");
        expect(serialized).not.toContain("Expected");
        expect(serialized).not.toContain("JSON");
    });

    it("returns 500 when an async handler throws", async () => {
        const response = await request(app).get("/api/async-boom");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            success: false,
            statusCode: 500,
            message: "Ha ocurrido un error inesperado en el servidor."
        });
        expect(JSON.stringify(response.body)).not.toContain("async boom");
    });

    it("returns the English generic message for English clients", async () => {
        const response = await request(app)
            .get("/api/boom")
            .set("Accept-Language", "en-US,en;q=0.9");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            success: false,
            statusCode: 500,
            message: "An unexpected error occurred on the server."
        });
    });

    it("returns a JSON 404 for unmatched routes without logging", async () => {
        const response = await request(app).get("/nope");

        expect(response.status).toBe(404);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body).toEqual({
            success: false,
            statusCode: 404,
            message: "Recurso no encontrado."
        });
        expect(console.error).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("returns the English 404 message for English clients", async () => {
        const response = await request(app)
            .get("/nope")
            .set("Accept-Language", "en-US,en;q=0.9");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            success: false,
            statusCode: 404,
            message: "Resource not found."
        });
    });

    it("returns a JSON 404 for unmatched methods instead of Express HTML", async () => {
        const response = await request(app).patch(`/api/products/${new mongoose.Types.ObjectId()}`);

        expect(response.status).toBe(404);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body.success).toBe(false);
        expect(response.body.statusCode).toBe(404);
        expect(JSON.stringify(response.body)).not.toContain("Cannot PATCH");
    });

    it("keeps returning a JSON 500 when an existing route throws", async () => {
        const response = await request(app).get("/api/boom");

        expect(response.status).toBe(500);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body.success).toBe(false);
        expect(response.body.statusCode).toBe(500);
    });

    it("declares exactly three parameters so Express treats it as middleware", () => {
        expect(notFoundHandler.length).toBe(3);
    });

    it("delegates to next when headers were already sent", () => {
        const error = new Error("late failure");
        const req = { method: "GET", originalUrl: "/api/late", headers: {} };
        const res = {
            headersSent: true,
            status: jest.fn(),
            json: jest.fn()
        };
        const next = jest.fn();

        const result = errorHandler(error, req, res, next);

        expect(result).toBeUndefined();
        expect(next).toHaveBeenCalledWith(error);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });
});

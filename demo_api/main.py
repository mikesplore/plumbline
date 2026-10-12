"""Small API with seeded contract defects for Plumbline's demo."""

import asyncio
from fastapi import FastAPI, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse

app = FastAPI(title="Plumbline Demo API", version="1.0.0", servers=[{"url": "http://127.0.0.1:8001"}])

_items = [{"id": 1, "name": "Notebook", "price": 4.5}]
_redeemed_orders: set[int] = set()
_security = [{"BearerAuth": []}]


def _openapi_schema():
    if app.openapi_schema is None:
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes, servers=app.servers)
        schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = {
            "type": "http", "scheme": "bearer"
        }
        app.openapi_schema = schema
    return app.openapi_schema


app.openapi = _openapi_schema


@app.get("/items", operation_id="list_items", summary="List items")
async def list_items():
    return _items


@app.get("/items/{id}", operation_id="get_item", summary="Get an item", openapi_extra={"responses": {"200": {"content": {"application/json": {"schema": {"type": "object", "properties": {"id": {"type": "integer"}, "name": {"type": "string"}, "price": {"type": "number"}}}}}}}})
async def get_item(id: int):
    item = next((item for item in _items if item["id"] == id), None)
    if item is None:
        return JSONResponse(status_code=404, content={"detail": "Item not found"})
    # Seeded defect: the documented number is returned as a string.
    return {**item, "price": str(item["price"])}


@app.get("/admin/users", operation_id="list_admin_users", summary="List admin users")
async def list_admin_users():
    # Seeded defect: the operation is documented as secured but accepts no token.
    return [{"id": 1, "name": "Admin"}]


@app.post("/items", operation_id="create_item", summary="Create an item", status_code=201,
          openapi_extra={"security": _security, "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}, "price": {"type": "number"}}}}}}})
async def create_item(payload: dict):
    # Seeded defect: missing name succeeds and a wrong type returns a server error.
    if "name" in payload and not isinstance(payload["name"], str):
        return JSONResponse(status_code=500, content={"detail": "TypeError: expected string"})
    item = {"id": len(_items) + 1, "name": payload.get("name"), "price": payload.get("price", 0)}
    _items.append(item)
    return item


@app.delete("/items/{id}", operation_id="delete_item", summary="Delete an item", status_code=204,
            openapi_extra={"security": _security})
async def delete_item(id: int):
    # Seeded defect: the viewer token would be allowed by the demo policy.
    _items[:] = [item for item in _items if item["id"] != id]


@app.get("/debug/crash", operation_id="debug_crash", summary="Trigger a debug error")
async def debug_crash():
    return JSONResponse(status_code=500, content={"detail": "Traceback (most recent call last): File '/srv/app/main.py', line 42, in crash"})


@app.get("/search", operation_id="search_items", summary="Search items", responses={429: {"description": "Rate limit exceeded"}})
async def search_items(q: str = ""):
    return [item for item in _items if q.lower() in item["name"].lower()]


@app.post("/orders/redeem", operation_id="redeem_order", summary="Redeem an order", status_code=200,
          openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["order_id"], "properties": {"order_id": {"type": "integer"}}}}}}})
async def redeem_order(request: Request):
    payload = await request.json()
    order_id = payload.get("order_id")
    if order_id in _redeemed_orders:
        return JSONResponse(status_code=409, content={"order_id": order_id, "redeemed": False})
    # Seeded defect: concurrent requests can both pass the check before either write.
    await asyncio.sleep(0)
    _redeemed_orders.add(order_id)
    return {"order_id": order_id, "redeemed": True}

"""Generate the Location command client from FastAPI's OpenAPI models."""
import client_generator as gen

TARGET = "web/src/location_generated.ts"
NAMES = ("TreeNode", "TreeLocation", "TreeResponse", "LocationCommandResult", "CreateLocation", "EditLocation", "DeleteLocation", "DeleteLocationResult", "SetLocationHidden", "LocationHiddenResult", "SetLocationForTrade", "LocationForTradeResult")

BODY = """
%(error)s
async function locationRequest<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
%(failure)s
  return response.json() as Promise<T>;
}
export const getLocationTree = () => locationRequest<TreeResponse>('/api/location-tree');
export const createLocation = (body: CreateLocation) => locationRequest<LocationCommandResult>('/api/location-tree', 'POST', body);
export const editLocation = (id: string, body: EditLocation) => locationRequest<LocationCommandResult>(`/api/location-tree/${id}`, 'PATCH', body);
export const deleteLocation = (id: string, body: DeleteLocation) => locationRequest<DeleteLocationResult>(`/api/location-tree/${id}`, 'DELETE', body);
export const setLocationHidden = (id: string, body: SetLocationHidden) => locationRequest<LocationHiddenResult>(`/api/location-tree/${id}/hidden`, 'PUT', body);
export const setLocationForTrade = (id: string, body: SetLocationForTrade) => locationRequest<LocationForTradeResult>(`/api/location-tree/${id}/for-trade`, 'PUT', body);
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("LocationError"),
                   "failure": gen.failure_block("LocationError", "LOCATION_REQUEST_FAILED")}
    return gen.assemble([gen.header("generate_location_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)

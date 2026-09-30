-- Keeps an uncertain Add retry's original numeric result for the same 24-hour
-- window as its item-free mutation_request. No Edition or Location IDs live here.
CREATE TABLE mutation_response (
  owner_id text NOT NULL,
  request_key uuid NOT NULL,
  result_quantity bigint NOT NULL CHECK (result_quantity > 0),
  result_version bigint NOT NULL CHECK (result_version > 0),
  PRIMARY KEY (owner_id, request_key),
  FOREIGN KEY (owner_id, request_key)
    REFERENCES mutation_request(owner_id, request_key) ON DELETE CASCADE
);
